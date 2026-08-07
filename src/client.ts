import {
  createPublicClient,
  createWalletClient,
  defineChain,
  hashTypedData,
  http,
  keccak256,
  maxUint256,
  toHex,
  verifyTypedData,
  zeroAddress,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { erc20Abi, escrowAbi, stakingVaultAbi, subscriptionEscrowAbi, yieldVaultAbi } from "./abi.js";
import {
  buildFundUserOperation,
  type FundUserOpResult,
  type InjectableSmartAccount,
  type MinimalBundlerClient,
  type SmartAccountConfig,
} from "./smartAccount.js";
import {
  OFFER_TYPE,
  SUB_OFFER_TYPE,
  offerToTuple,
  subOfferToTuple,
  validateX402Quote,
  type Address,
  type Hex,
  type OfferJson,
  type OnchainDeal,
  type OnchainSub,
  type SubOfferJson,
  type X402Quote,
  type X402QuoteRequest,
} from "./types.js";

export interface AgentConfig {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  usdc: Address;
  privateKey: Hex;
  /// Optional Hub base URL — enables publishOffer + the off-chain content relay (reason/blob).
  hubUrl?: string;
  /// Timeout (ms) applied to every plain-HTTP call the SDK makes (x402 seller endpoints, Hub relay).
  /// Default 15_000. The RPC transport has its own 12s bound; this covers the fetch() paths, where
  /// Node has NO default timeout — without it a hung/hostile endpoint stalls the sequential agent forever.
  httpTimeoutMs?: number;
  /// Optional StakingVault address. ABSENT => staking is DISABLED for this agent (stake/unstake/
  /// withdrawStake/stakeBalance throw a clear error). Present => the agent can post standing collateral
  /// the vault holds (and an arbiter may slash on adjudicated fault). The vault is a NEW auxiliary
  /// contract that READS the Escrow but never mutates it — see contracts/src/StakingVault.sol.
  stakingVault?: Address;
  /// OPTIONAL ERC-4337 smart-account transport for GASLESS funding (approve+fund batched into one
  /// Paymaster-sponsored UserOperation against a Coinbase Smart Wallet). ABSENT => the smart-account
  /// transport is DISABLED and the EOA path is used — the EOA path is and remains the DEFAULT. Present
  /// => fundViaSmartAccount() becomes usable; everything else (signing, dealId, lifecycle) is unchanged.
  /// See sdk/src/smartAccount.ts. The gasless SEND needs a live bundler RPC — first-class on Robinhood
  /// Chain via Alchemy/ZeroDev (docs.robinhood.com/chain/account-abstraction).
  smartAccount?: SmartAccountConfig;
  /// OPTIONAL YieldVault address. ABSENT => yield is DISABLED for this agent (depositYield/withdrawYield/
  /// yieldBalance/yieldShareValue throw a clear error). Present => the agent can deposit its OWN idle/
  /// surplus USDC and earn share-accounted yield. The vault is a NEW standalone contract that NEVER holds
  /// escrow principal or bonds — there is no code path from a deal's funds into it. See
  /// contracts/src/YieldVault.sol. WARNING: with an AMM/LP yield source set on the vault there is NO 1:1
  /// floor — the opt-in depositor knowingly bears market risk; only the no-source pass-through is exactly
  /// 1:1 redeemable. The vault is approved as the spender for deposits (NOT the escrow).
  yieldVault?: Address;
  /// OPTIONAL SubscriptionEscrow address (Tier 3 "rent"). ABSENT => subscriptions are DISABLED for this
  /// agent (startSubscription/activate/claimPeriod/disputePeriod/resolvePeriod/revoke/expireSub/
  /// closeSubscription/getSub/subStatus + signSubOffer throw a clear "subscriptions disabled" error).
  /// Present => the agent can drive the recurring per-period escrow lifecycle. The contract is the
  /// SIBLING of `escrow` (its own EIP-712 domain "ObulusSubscription"); it HOLDS prepaid periods + bonds
  /// and only ever moves funds per its own rules — rent for delivered periods → seller, unconsumed
  /// periods + bond → subscriber. See contracts/src/SubscriptionEscrow.sol. Single-Escrow methods are
  /// untouched; this is a separate, independently-flagged surface.
  subscriptionEscrow?: Address;
  label?: string;
}

export interface OfferInput {
  buyer?: Address; // omit for an open offer
  arbiter: Address;
  priceUsd: number;
  buyerBondUsd: number;
  sellerBondUsd: number;
  feeBps: number;
  /// Seconds from now until the seller must have delivered.
  deliverInS: number;
  /// Seconds the buyer has to confirm/dispute after delivery.
  confirmWindowS: number;
  spec: string;
  sigTtlS?: number; // default 24h
}

/// Inputs for building a subscription offer (Tier 3 "rent"). Mirrors OfferInput's ergonomics: USD
/// amounts in human units (usd6'd into base-6), durations in seconds. The SELLER builds + signs this.
export interface SubOfferInput {
  subscriber?: Address; // omit for an open offer (the funder becomes the subscriber)
  arbiter: Address;
  /// Per-period price in USD (charged to the subscriber, paid to the seller per delivered period).
  periodPriceUsd: number;
  sellerBondUsd: number;
  subscriberBondUsd: number;
  numPeriods: number;
  /// Length of one period in seconds.
  periodLengthS: number;
  /// Seconds after a period ends during which the subscriber may dispute it.
  challengeWindowS: number;
  /// Unix seconds when period 0 starts. Omit => now.
  startAt?: number;
  feeBps: number;
  spec: string;
  sigTtlS?: number; // default 24h
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const usd6 = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

/// One agent identity on the escrow protocol: a viem account + the full deal lifecycle, with the
/// Hub used ONLY as an untrusted off-chain relay (offers book, dispute reasons, deliverable blobs).
/// Every state change is a real transaction signed by this agent; receipts are checked (a mined
/// revert throws). Methods are sequential per-agent by design — run one lifecycle step at a time.
export class AgentClient {
  readonly account: PrivateKeyAccount;
  readonly address: Address;
  readonly label: string;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly cfg: AgentConfig;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.account = privateKeyToAccount(cfg.privateKey);
    this.address = this.account.address;
    this.label = cfg.label ?? this.address.slice(0, 8);
    const chain = defineChain({
      id: cfg.chainId,
      name: `chain-${cfg.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    // Public-RPC etiquette: cap retries (viem defaults to 3 → amplifies 429s on a shared endpoint)
    // and bound the per-request timeout.
    const transport = http(cfg.rpcUrl, { retryCount: 1, retryDelay: 400, timeout: 12_000 });
    this.pub = createPublicClient({ chain, transport });
    this.wallet = createWalletClient({ account: this.account, chain, transport });
  }

  // ── offers ────────────────────────────────────────────────────────────────

  buildOffer(i: OfferInput): OfferJson {
    const now = Math.floor(Date.now() / 1000);
    return {
      seller: this.address,
      buyer: i.buyer ?? ZERO,
      arbiter: i.arbiter,
      token: this.cfg.usdc,
      price: usd6(i.priceUsd).toString(),
      buyerBond: usd6(i.buyerBondUsd).toString(),
      sellerBond: usd6(i.sellerBondUsd).toString(),
      deliverDeadline: String(now + i.deliverInS),
      confirmWindow: String(i.confirmWindowS),
      feeBps: i.feeBps,
      specHash: keccak256(toHex(i.spec)),
      // ms + random suffix: two otherwise-identical offers must never collide on offerHash (== dealId)
      nonce: String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"),
      sigDeadline: String(now + (i.sigTtlS ?? 86_400)),
    };
  }

  /// offerHash == dealId — identical to what the contract computes in fund().
  offerHash(offer: OfferJson): Hex {
    return hashTypedData({
      domain: { name: "Obulus", version: "1", chainId: this.cfg.chainId, verifyingContract: this.cfg.escrow },
      types: OFFER_TYPE,
      primaryType: "Offer",
      message: offerToTuple(offer) as never,
    });
  }

  signOffer(offer: OfferJson): Promise<Hex> {
    return this.account.signTypedData({
      domain: { name: "Obulus", version: "1", chainId: this.cfg.chainId, verifyingContract: this.cfg.escrow },
      types: OFFER_TYPE,
      primaryType: "Offer",
      message: offerToTuple(offer) as never,
    });
  }

  /// Sign + post to the Hub's offer book (so cockpits and other agents can discover it).
  async publishOffer(i: OfferInput): Promise<{ offer: OfferJson; signature: Hex; offerHash: Hex }> {
    const offer = this.buildOffer(i);
    const signature = await this.signOffer(offer);
    await this.postSignedOffer(offer, signature);
    return { offer, signature, offerHash: this.offerHash(offer) };
  }

  /// Post an already-signed offer to the Hub's book (strict — throws if the Hub is unreachable;
  /// wrap in try/catch when the book is optional, the chain stays the source of truth).
  async postSignedOffer(offer: OfferJson, signature: Hex): Promise<void> {
    await this.hub("POST", "/offers", { offer, signature });
  }

  // ── x402: HTTP 402 "Payment Required" quote handshake ─────────────────────

  /// BUYER side. POST a job/spec to a seller's x402 endpoint and parse the 402 response into an
  /// X402Quote (the embedded Offer + the seller's signature are sufficient to fund). A 200 means
  /// "already paid / no payment required" → resolves to `null`. Any other status throws.
  async quote(endpoint: string, spec: X402QuoteRequest | string): Promise<X402Quote | null> {
    const body: X402QuoteRequest = typeof spec === "string" ? { spec } : spec;
    const res = await this.boundedFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, "x402: quote request");
    if (res.status === 200) return null; // already paid / nothing to pay
    if (res.status !== 402) throw new Error(`x402 quote ${endpoint} → ${res.status} ${await res.text().catch(() => "")}`);
    // The seller endpoint is UNTRUSTED: structurally validate the 402 body against the X402Quote
    // shape before trusting any of it, so a malformed offer fails early with a clear error.
    const raw = await res.json().catch(() => { throw new Error("x402: seller returned non-JSON 402 body"); });
    const quote = validateX402Quote(raw);
    this.assertQuoteTerms(quote);
    return quote;
  }

  /// SELLER side. Answer a buyer's quote request: build the Offer from a pricing handler, sign it
  /// (EIP-712), and return the X402Quote envelope to send back with HTTP 402. buildOffer stays the
  /// single source of truth so the offerHash the buyer funds equals the dealId the contract derives.
  async serveQuote(req: X402QuoteRequest, price: (req: X402QuoteRequest) => OfferInput | Promise<OfferInput>): Promise<X402Quote> {
    const input = await price(req);
    const offer = this.buildOffer(input);
    const signature = await this.signOffer(offer);
    const usdc = this.cfgUsdc();
    const amount = offer.price;
    return {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: this.networkLabel(),
          maxAmountRequired: amount,
          asset: usdc,
          payTo: this.cfgEscrow(),
          resource: req.resource ?? (req.spec ? `job:${offer.specHash.slice(2, 18)}` : offer.specHash),
          description: (req.spec ?? "").slice(0, 1024),
        },
      ],
      offer,
      signature,
      chainId: this.cfgChainId(),
      escrow: this.cfgEscrow(),
    };
  }

  /// BUYER convenience: quote → validate terms against OUR config → verify the seller's signature →
  /// fund. `opts` lets the caller cap spend so a hostile seller cannot auto-drain the buyer: the
  /// quoted price / buyerBond must not exceed maxPriceUsdc / maxBuyerBond (USDC base-6, as a string
  /// or bigint). Throws on a TERMS-only quote, a ceiling breach, or a signature that doesn't recover
  /// to the seller — all BEFORE the on-chain fund tx, so nothing is wasted on a guaranteed revert.
  ///
  /// SPEND-CEILING GUARANTEE (untrusted seller): the seller endpoint is untrusted, so this path NEVER
  /// grants the escrow a standing infinite allowance the way the EOA fund() default does. The USDC
  /// approval is SCOPED to exactly `price + buyerBond` (the precise amount fund() pulls — see
  /// Escrow.fund: `safeTransferFrom(buyer, escrow, price + buyerBond)`). So even with NO maxPriceUsdc
  /// cap supplied, a hostile/compromised seller cannot leave behind an allowance to drain a second
  /// time; the most they can extract is the price+bond of THIS one quote (which the caller saw and,
  /// if it set maxPriceUsdc/maxBuyerBond, has already bounded). Pass maxPriceUsdc to additionally
  /// refuse the deal outright above a price you choose.
  ///
  /// ARBITER + WINDOW GUARDS (strict by default): the spend ceiling alone does NOT bound the loss
  /// from a rigged dispute — a hostile endpoint naming a COLLUDING arbiter can win any dispute and
  /// take price + buyerBond, and a near-zero confirmWindow (the contract only rejects 0) lets the
  /// seller auto-release before the buyer can dispute. So this path REQUIRES the caller to pin
  /// `expectedArbiter` (the arbiter it actually trusts) or to opt out explicitly with
  /// `allowAnyArbiter: true`, and it enforces floor windows: `minConfirmWindowS` (default 600) and
  /// `minDeliverWindowS` (default 60), both overridable.
  async quoteAndFund(
    endpoint: string,
    spec: X402QuoteRequest | string,
    opts?: {
      maxPriceUsdc?: bigint | string;
      maxBuyerBond?: bigint | string;
      /// The ONLY arbiter this buyer accepts for the deal. Required unless allowAnyArbiter.
      expectedArbiter?: Address;
      /// Explicit opt-out for closed/dev setups where any arbiter is acceptable.
      allowAnyArbiter?: boolean;
      /// Floor (seconds) on offer.confirmWindow — the buyer's post-delivery dispute window. Default 600.
      minConfirmWindowS?: number;
      /// Floor (seconds) from now until offer.deliverDeadline. Default 60.
      minDeliverWindowS?: number;
    },
  ): Promise<{ dealId: Hex; txHash: Hex; offer: OfferJson }> {
    const quote = await this.quote(endpoint, spec); // validates structure + assertQuoteTerms
    if (!quote) throw new Error("x402: nothing to pay (endpoint returned 200) — no fundable quote");
    if (!quote.signature || quote.signature === "0x")
      throw new Error("x402: TERMS-only quote (no seller signature) — the seller must sign before funding");

    // Arbiter policy: the arbiter decides every dispute over the buyer's price + buyerBond, so it
    // must be one the buyer chose — never silently whatever the untrusted endpoint quoted.
    if (opts?.expectedArbiter && opts?.allowAnyArbiter)
      throw new Error("x402: expectedArbiter and allowAnyArbiter are mutually exclusive");
    if (!opts?.expectedArbiter && !opts?.allowAnyArbiter)
      throw new Error("x402: opts.expectedArbiter is required on the untrusted-seller path (or pass allowAnyArbiter: true) — a seller-chosen arbiter can win any dispute");
    if (opts?.expectedArbiter && quote.offer.arbiter.toLowerCase() !== opts.expectedArbiter.toLowerCase())
      throw new Error(`x402: offer.arbiter ${quote.offer.arbiter} != expectedArbiter ${opts.expectedArbiter}`);

    // Window floors: a too-short confirmWindow forfeits the dispute right; a past/near deliverDeadline
    // sets the deal up for an immediate timeout path.
    const minConfirm = opts?.minConfirmWindowS ?? 600;
    const minDeliver = opts?.minDeliverWindowS ?? 60;
    const nowS = Math.floor(Date.now() / 1000);
    const confirmS = Number(quote.offer.confirmWindow);
    const deliverInS = Number(quote.offer.deliverDeadline) - nowS;
    // Defense-in-depth: validateX402Quote already pins both fields to digit strings ≤ u64, but a
    // NaN here would compare false against the floor and SILENTLY PASS — fail closed instead.
    if (!Number.isFinite(confirmS) || confirmS < minConfirm)
      throw new Error(`x402: confirmWindow ${confirmS}s is below minConfirmWindowS ${minConfirm}s — too short to dispute after delivery`);
    if (!Number.isFinite(deliverInS) || deliverInS < minDeliver)
      throw new Error(`x402: deliverDeadline is ${deliverInS}s away, below minDeliverWindowS ${minDeliver}s`);

    // Spend ceiling: refuse to fund a quote whose price/buyerBond exceeds the caller's limit.
    if (opts?.maxPriceUsdc !== undefined && BigInt(quote.offer.price) > BigInt(opts.maxPriceUsdc))
      throw new Error(`x402: quoted price ${quote.offer.price} exceeds maxPriceUsdc ${opts.maxPriceUsdc}`);
    if (opts?.maxBuyerBond !== undefined && BigInt(quote.offer.buyerBond) > BigInt(opts.maxBuyerBond))
      throw new Error(`x402: quoted buyerBond ${quote.offer.buyerBond} exceeds maxBuyerBond ${opts.maxBuyerBond}`);

    // MEANINGFUL pre-fund check: the seller's signature MUST recover to offer.seller under our escrow
    // domain (the same check fund() makes on-chain). Fail fast here instead of paying gas for a revert.
    if (!(await this.verifyOfferSignature(quote.offer, quote.signature as Hex)))
      throw new Error("x402: seller signature does not recover to offer.seller under the escrow domain");

    // SCOPED approval (not the EOA fund()'s infinite approve): a quote from an untrusted seller gets
    // an allowance of exactly price+buyerBond, so no standing allowance survives the fund tx.
    return this.fund(quote.offer, quote.signature as Hex, { scopedApproval: true }).then((r) => ({ ...r, offer: quote.offer }));
  }

  /// Validate a received quote against the buyer's OWN configured chain identity — NOT merely
  /// against the seller-supplied `accepts` block (which a hostile seller controls). The seller
  /// endpoint is untrusted, so every term that decides where the buyer's funds go is checked against
  /// the buyer's own config (cfg.usdc / cfg.escrow / cfg.chainId / own address).
  private assertQuoteTerms(quote: X402Quote): void {
    if (quote.x402Version !== 1) throw new Error(`x402: unsupported version ${quote.x402Version}`);
    const a = quote.accepts?.[0];
    if (!a) throw new Error("x402: quote has no accepts");
    const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

    // Chain identity must be OURS.
    if (quote.chainId !== this.cfgChainId()) throw new Error(`x402: chainId mismatch (${quote.chainId} != ${this.cfgChainId()})`);
    if (!eq(quote.escrow, this.cfgEscrow())) throw new Error("x402: escrow mismatch");

    // The token the buyer would pay MUST be the buyer's OWN configured USDC — not just whatever the
    // seller's accepts/offer agree on (a hostile seller could agree on a token they control).
    if (!eq(quote.offer.token, this.cfgUsdc())) throw new Error("x402: offer.token is not the buyer's configured USDC");
    // Funds escrow into the buyer's OWN escrow contract (payTo), never a seller-chosen address.
    if (!eq(a.payTo, this.cfgEscrow())) throw new Error("x402: accepts.payTo is not the buyer's configured escrow");
    // The offer must be open (zero buyer) or directed at US — never at a third party.
    if (!eq(quote.offer.buyer, zeroAddress) && !eq(quote.offer.buyer, this.address))
      throw new Error("x402: offer.buyer is neither open nor this buyer");

    // Internal consistency of the (descriptive) accepts block vs the canonical embedded offer.
    if (a.maxAmountRequired !== quote.offer.price) throw new Error("x402: accepts.maxAmountRequired != offer.price");
    if (!eq(a.asset, quote.offer.token)) throw new Error("x402: accepts.asset != offer.token");
  }

  /// Verify the seller's EIP-712 signature recovers to offer.seller under THIS escrow domain — the
  /// exact check the contract's fund() and the backend test perform. A buyer runs this BEFORE the
  /// fund tx so a bad/forged signature fails fast client-side instead of wasting gas on a revert.
  /// A garbage signature from a hostile seller (e.g. an off-curve point) recovers nothing — we treat
  /// any recovery error as "not valid" (return false) so the caller gets a clean domain-level failure
  /// instead of an opaque crypto exception leaking through.
  async verifyOfferSignature(offer: OfferJson, signature: Hex): Promise<boolean> {
    try {
      return await verifyTypedData({
        address: offer.seller,
        domain: { name: "Obulus", version: "1", chainId: this.cfg.chainId, verifyingContract: this.cfg.escrow },
        types: OFFER_TYPE,
        primaryType: "Offer",
        message: offerToTuple(offer) as never,
        signature,
      });
    } catch {
      return false; // unrecoverable signature (off-curve, wrong length, etc.) → invalid, not a throw
    }
  }

  // ── lifecycle (buyer / seller / arbiter) ──────────────────────────────────

  /// Buyer: approve (if needed) then fund — the DEFAULT (EOA) transport. dealId == offerHash.
  ///
  /// TRUSTED-INPUT-ONLY primitive: this performs NO arbiter/window/ceiling checks on the offer —
  /// those guards live in quoteAndFund(), the required entry point for offers from an UNTRUSTED
  /// endpoint. Call fund() directly only with an offer you built or vetted yourself.
  ///
  /// `opts.scopedApproval` (default false) controls the allowance granted to the escrow:
  ///   - false (default): infinite (maxUint256) approve, set ONCE and reused across a trusted agent's
  ///     own repeated deals — the standing-allowance convenience the EOA path is built around.
  ///   - true: approve EXACTLY price+buyerBond (the precise amount fund() pulls). Used by the
  ///     untrusted-seller x402 quoteAndFund path so no standing allowance survives the fund tx.
  async fund(offer: OfferJson, signature: Hex, opts?: { scopedApproval?: boolean }): Promise<{ dealId: Hex; txHash: Hex }> {
    await this.ensureApproval(BigInt(offer.price) + BigInt(offer.buyerBond), opts);
    const txHash = await this.write("fund", [offerToTuple(offer), signature]);
    return { dealId: this.offerHash(offer), txHash };
  }

  /// True iff the OPT-IN smart-account (ERC-4337) transport is configured on this client. When false,
  /// fundViaSmartAccount() throws and fund() (the EOA path, the DEFAULT) is the only funding route.
  get smartAccountEnabled(): boolean {
    return this.cfg.smartAccount !== undefined;
  }

  /// OPT-IN gasless buyer funding via a Coinbase Smart Wallet (ERC-4337). Batches USDC.approve(escrow,
  /// price+buyerBond) + Escrow.fund(offer, sellerSig) into ONE Paymaster-sponsored UserOperation.
  ///
  /// dealId is derived from offerHash(offer) — IDENTICAL to the EOA fund() path, so buildOffer/offerHash
  /// stays the single source of truth and the dealId is unaffected by the transport chosen.
  ///
  /// SEND is gated on a configured smartAccount.bundlerUrl: with no bundler this CONSTRUCTS the typed
  /// UserOperation (correct sender + batched callData + paymaster fields when a paymaster is set) and
  /// returns it UNSENT (result.sent === false). The real gasless send (UserOp -> Paymaster -> Bundler
  /// -> on-chain) needs live ERC-4337 infra — first-class on Robinhood Chain via Alchemy/ZeroDev
  /// bundlers + a funded gas policy — and cannot be exercised by automated tests.
  ///
  /// `opts.bundlerClient` lets a test inject a stub bundler and `opts.account` an already-built smart
  /// account, so the whole construction is verifiable WITHOUT a live bundler OR the factory getAddress
  /// RPC. Neither is needed in production (the real Coinbase Smart Wallet + bundler are built from cfg).
  async fundViaSmartAccount(
    offer: OfferJson,
    signature: Hex,
    opts?: { bundlerClient?: MinimalBundlerClient; account?: InjectableSmartAccount },
  ): Promise<FundUserOpResult & { dealId: Hex }> {
    if (!this.cfg.smartAccount)
      throw new Error("smart-account transport disabled — no smartAccount config on this AgentClient (EOA fund() is the default)");
    const result = await buildFundUserOperation({
      offer,
      signature,
      escrow: this.cfg.escrow,
      usdc: this.cfg.usdc,
      chainId: this.cfg.chainId,
      rpcUrl: this.cfg.rpcUrl,
      smartAccount: this.cfg.smartAccount,
      fallbackOwnerKey: this.cfg.privateKey,
      bundlerClient: opts?.bundlerClient,
      account: opts?.account,
    });
    const dealId = this.offerHash(offer);
    return { ...result, dealId };
  }

  /// Seller: post the bond (approval), commit keccak256(content) on-chain, then relay the blob.
  async markDelivered(dealId: Hex, content: string, sellerBond: bigint): Promise<{ txHash: Hex; payloadHash: Hex; relayed: boolean }> {
    if (sellerBond > 0n) await this.ensureApproval(sellerBond);
    const payloadHash = keccak256(toHex(content));
    const txHash = await this.write("markDelivered", [dealId, payloadHash]);
    const relayed = await this.tryHub("POST", "/relay/delivery", {
      dealId,
      payloadHash,
      payloadRef: "hub://blob/" + dealId.slice(2, 10),
      blobBase64: Buffer.from("ciphertext:" + content, "utf8").toString("base64"),
    });
    return { txHash, payloadHash, relayed };
  }

  async confirm(dealId: Hex): Promise<{ txHash: Hex }> {
    return { txHash: await this.write("confirm", [dealId]) };
  }

  /// Buyer: dispute on-chain, then relay the human-readable reason for the arbiter/triage.
  async dispute(dealId: Hex, reason: string): Promise<{ txHash: Hex; relayed: boolean }> {
    const txHash = await this.write("dispute", [dealId]);
    const relayed = await this.tryHub("POST", "/relay/dispute", { dealId, reason });
    return { txHash, relayed };
  }

  /// Arbiter only. sellerBps = seller's share of the price (0..10000).
  async resolve(dealId: Hex, sellerBps: number): Promise<{ txHash: Hex }> {
    return { txHash: await this.write("resolve", [dealId, sellerBps]) };
  }

  async claimTimeout(dealId: Hex): Promise<{ txHash: Hex }> {
    return { txHash: await this.write("claimTimeout", [dealId]) };
  }

  async refundExpired(dealId: Hex): Promise<{ txHash: Hex }> {
    return { txHash: await this.write("refundExpired", [dealId]) };
  }

  async resolveExpired(dealId: Hex): Promise<{ txHash: Hex }> {
    return { txHash: await this.write("resolveExpired", [dealId]) };
  }

  /// Pull-payment: move this agent's credited balance back to its wallet. No-ops revert on 0.
  async withdraw(): Promise<{ txHash: Hex }> {
    return { txHash: await this.write("withdraw", []) };
  }

  /// Withdraw only when something is credited (the contract reverts on a zero withdraw).
  async withdrawIfAny(): Promise<{ txHash?: Hex; amount: bigint }> {
    const amount = await this.credits();
    if (amount === 0n) return { amount };
    const { txHash } = await this.withdraw();
    return { txHash, amount };
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async getDeal(dealId: Hex): Promise<OnchainDeal> {
    return (await this.pub.readContract({ address: this.cfg.escrow, abi: escrowAbi, functionName: "getDeal", args: [dealId] })) as OnchainDeal;
  }

  async credits(of: Address = this.address): Promise<bigint> {
    return (await this.pub.readContract({ address: this.cfg.escrow, abi: escrowAbi, functionName: "credits", args: [of] })) as bigint;
  }

  async usdcBalance(of: Address = this.address): Promise<bigint> {
    return (await this.pub.readContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [of] })) as bigint;
  }

  async ethBalance(of: Address = this.address): Promise<bigint> {
    return this.pub.getBalance({ address: of });
  }

  /// Approve the escrow as USDC spender for `amount`.
  ///
  /// Default (`scopedApproval` falsy): INFINITE (maxUint256) approve set ONCE and reused — skipped when
  /// the current allowance already covers `amount`. This is the convenience the trusted EOA path is
  /// built around (a self-driven agent funds its own repeated deals without re-approving).
  ///
  /// `scopedApproval: true`: approve EXACTLY `amount` (the precise sum fund() pulls). Used for the
  /// untrusted-seller x402 path so NO standing allowance survives the fund tx — a hostile seller can
  /// never re-pull. If a larger (e.g. leftover infinite) allowance already stands, it is reset DOWN to
  /// exactly `amount`; if it already equals `amount`, the approve is skipped.
  async ensureApproval(amount: bigint, opts?: { scopedApproval?: boolean }): Promise<void> {
    const allowance = (await this.pub.readContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [this.address, this.cfg.escrow] })) as bigint;
    if (opts?.scopedApproval) {
      if (allowance === amount) return; // already scoped to exactly this amount
      await this.approveEscrow(amount);
      return;
    }
    if (allowance >= amount) return;
    await this.approveEscrow(maxUint256);
  }

  /// Submit a USDC approve(escrow, value) and require the tx to mine successfully.
  private async approveEscrow(value: bigint): Promise<void> {
    const txHash = await this.wallet.writeContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "approve", args: [this.cfg.escrow, value], chain: this.wallet.chain, account: this.account });
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`approve reverted (${txHash})`);
  }

  // ── staking (StakingVault) ──────────────────────────────────────────────────
  // The vault is OPT-IN: every method requires cfg.stakingVault to be set (absent => staking disabled).
  // Mirrors StakingVault.sol exactly: stake pulls USDC (approve the VAULT, not the escrow), unstake
  // queues a delayed withdrawal, withdrawStake claims a matured queue, stakeBalance reads standing stake.

  /// Stake `amount` (USDC base-6) of standing collateral into the vault. Approves the VAULT for the
  /// pull (the vault, NOT the escrow, is the spender here), then calls stake().
  async stake(amount: bigint): Promise<{ txHash: Hex }> {
    const vault = this.requireVault();
    await this.ensureVaultApproval(amount);
    return { txHash: await this.writeVault(vault, "stake", [amount]) };
  }

  /// Begin withdrawing `amount` from stake → moves it to a time-locked pending bucket (still vault-held,
  /// not yet claimable). Claim later via withdrawStake() once the vault's withdrawalDelay has elapsed.
  async unstake(amount: bigint): Promise<{ txHash: Hex }> {
    const vault = this.requireVault();
    return { txHash: await this.writeVault(vault, "unstake", [amount]) };
  }

  /// Claim a MATURED pending withdrawal in full (reverts if nothing is pending or still locked). Named
  /// withdrawStake (not withdraw) to avoid colliding with the Escrow pull-payment withdraw() above.
  async withdrawStake(): Promise<{ txHash: Hex }> {
    const vault = this.requireVault();
    return { txHash: await this.writeVault(vault, "withdraw", []) };
  }

  /// Standing stake balance (USDC base-6) of `addr` in the vault (excludes queued/pending withdrawals).
  async stakeBalance(addr: Address = this.address): Promise<bigint> {
    const vault = this.requireVault();
    return (await this.pub.readContract({ address: vault, abi: stakingVaultAbi, functionName: "stakeOf", args: [addr] })) as bigint;
  }

  /// The queued (pending) withdrawal for `addr`: { amount, unlockAt } — amount 0n when none is queued.
  async pendingStake(addr: Address = this.address): Promise<{ amount: bigint; unlockAt: bigint }> {
    const vault = this.requireVault();
    const [amount, unlockAt] = (await this.pub.readContract({
      address: vault, abi: stakingVaultAbi, functionName: "pendingWithdrawal", args: [addr],
    })) as readonly [bigint, bigint];
    return { amount, unlockAt };
  }

  private requireVault(): Address {
    if (!this.cfg.stakingVault) throw new Error("staking disabled — no stakingVault address configured on this AgentClient");
    return this.cfg.stakingVault;
  }

  /// Infinite-approve the VAULT once (distinct from the escrow approval); skip when already covered.
  private async ensureVaultApproval(amount: bigint): Promise<void> {
    const vault = this.requireVault();
    const allowance = (await this.pub.readContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [this.address, vault] })) as bigint;
    if (allowance >= amount) return;
    const txHash = await this.wallet.writeContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "approve", args: [vault, maxUint256], chain: this.wallet.chain, account: this.account });
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`vault approve reverted (${txHash})`);
  }

  /// Like write(), but against the StakingVault address + ABI (the escrow write() is hardcoded to the
  /// escrow). A mined revert throws, mirroring the escrow path.
  private async writeVault(vault: Address, functionName: string, args: readonly unknown[]): Promise<Hex> {
    const txHash = await this.wallet.writeContract({
      address: vault,
      abi: stakingVaultAbi,
      functionName: functionName as never,
      args: args as never,
      chain: this.wallet.chain,
      account: this.account,
    } as never);
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${txHash})`);
    return txHash;
  }

  // ── yield (YieldVault) ──────────────────────────────────────────────────────
  // The vault is OPT-IN: every method requires cfg.yieldVault to be set (absent => yield disabled).
  // Mirrors YieldVault.sol exactly: depositYield pulls USDC (approve the VAULT, not the escrow) and
  // mints share-accounted balance; withdrawYield burns share-equivalent for a gross-asset withdraw, or
  // (when a share count is given) redeems an explicit share count; yieldBalance reads the depositor's
  // current asset value; yieldShareValue reads the live share price as 1e6-scaled USDC per 1 share.
  // NOTE: this never deposits escrow principal or bonds — only the agent's OWN surplus USDC.

  /// Whether yield is enabled on this client (a YieldVault address is configured). When false the yield
  /// methods throw a clear error and the agent has no yield surface at all.
  get yieldEnabled(): boolean {
    return this.cfg.yieldVault !== undefined;
  }

  /// Deposit `amount` (USDC base-6) of the agent's OWN surplus USDC into the vault, minting shares to
  /// this agent. Approves the VAULT for the pull (the vault, NOT the escrow, is the spender), then
  /// deposit(amount, this.address). Returns the tx hash.
  async depositYield(amount: bigint): Promise<{ txHash: Hex }> {
    const vault = this.requireYieldVault();
    if (amount <= 0n) throw new Error("depositYield: amount must be > 0");
    await this.ensureYieldApproval(amount);
    return { txHash: await this.writeYield(vault, "deposit", [amount, this.address]) };
  }

  /// Withdraw from the vault back to this agent. Pass `{ assets }` to withdraw an explicit gross USDC
  /// amount (the share-equivalent is burned) or `{ shares }` to redeem an explicit share count. Exactly
  /// one must be given. `minAssetsOut` (default 0n) is the slippage floor on the NET assets received —
  /// pass a non-zero value when the vault has a lossy/AMM source so an undershoot reverts client-side.
  async withdrawYield(
    args: { assets: bigint; shares?: undefined } | { shares: bigint; assets?: undefined },
    minAssetsOut: bigint = 0n,
  ): Promise<{ txHash: Hex }> {
    const vault = this.requireYieldVault();
    if (args.assets !== undefined && args.shares !== undefined)
      throw new Error("withdrawYield: pass exactly one of { assets } or { shares }");
    if (args.shares !== undefined) {
      if (args.shares <= 0n) throw new Error("withdrawYield: shares must be > 0");
      return { txHash: await this.writeYield(vault, "redeem", [args.shares, this.address, minAssetsOut]) };
    }
    if (args.assets === undefined) throw new Error("withdrawYield: pass exactly one of { assets } or { shares }");
    if (args.assets <= 0n) throw new Error("withdrawYield: assets must be > 0");
    return { txHash: await this.writeYield(vault, "withdraw", [args.assets, this.address, minAssetsOut]) };
  }

  /// The depositor's current vault position for `addr`: raw shares held + the live asset VALUE of those
  /// shares (USDC base-6, gross of any withdrawal fee). value == convertToAssets(shares) on-chain.
  async yieldBalance(addr: Address = this.address): Promise<{ shares: bigint; value: bigint }> {
    const vault = this.requireYieldVault();
    const shares = (await this.pub.readContract({
      address: vault, abi: yieldVaultAbi, functionName: "balanceOf", args: [addr],
    })) as bigint;
    const value =
      shares === 0n
        ? 0n
        : ((await this.pub.readContract({
            address: vault, abi: yieldVaultAbi, functionName: "convertToAssets", args: [shares],
          })) as bigint);
    return { shares, value };
  }

  /// The live share price: USDC (base-6) value of ONE share, scaled by 1e6 so it survives integer math
  /// (i.e. the value of 1e6 shares). With NO yield source on the vault this is exactly 1_000_000 (1.0);
  /// it rises as a principal-protected source accrues, and CAN fall below 1.0 for a lossy/AMM source.
  async yieldShareValue(): Promise<bigint> {
    const vault = this.requireYieldVault();
    return (await this.pub.readContract({
      address: vault, abi: yieldVaultAbi, functionName: "convertToAssets", args: [1_000_000n],
    })) as bigint;
  }

  private requireYieldVault(): Address {
    if (!this.cfg.yieldVault) throw new Error("yield disabled — no yieldVault address configured on this AgentClient");
    return this.cfg.yieldVault;
  }

  /// Infinite-approve the YIELD VAULT once (distinct from the escrow + staking approvals); skip when
  /// the current allowance already covers `amount`. The VAULT is the spender — never the escrow.
  private async ensureYieldApproval(amount: bigint): Promise<void> {
    const vault = this.requireYieldVault();
    const allowance = (await this.pub.readContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [this.address, vault] })) as bigint;
    if (allowance >= amount) return;
    const txHash = await this.wallet.writeContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "approve", args: [vault, maxUint256], chain: this.wallet.chain, account: this.account });
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`yield vault approve reverted (${txHash})`);
  }

  /// Like writeVault(), but against the YieldVault address + ABI. A mined revert throws.
  private async writeYield(vault: Address, functionName: string, args: readonly unknown[]): Promise<Hex> {
    const txHash = await this.wallet.writeContract({
      address: vault,
      abi: yieldVaultAbi,
      functionName: functionName as never,
      args: args as never,
      chain: this.wallet.chain,
      account: this.account,
    } as never);
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${txHash})`);
    return txHash;
  }

  // ── subscriptions (SubscriptionEscrow — Tier 3 "rent") ──────────────────────
  // OPT-IN: every method requires cfg.subscriptionEscrow to be set (absent => subscriptions disabled).
  // Mirrors the single-Escrow AgentClient discipline: buildSubOffer/signSubOffer keep the canonical
  // subOfferToTuple as the single encoder, so subId == subOfferHash(offer) == the EIP-712 digest the
  // contract derives in start() — zero drift. Money flow (authoritative): the subscriber prepays
  // numPeriods*periodPrice + subscriberBond at start; the seller posts sellerBond at activate; rent for
  // each DELIVERED period (minus feeBps) credits the seller on claimPeriod; revoke refunds the UNCONSUMED
  // periods to the subscriber; close returns both bonds. The escrow (NOT a vault) is the USDC spender.

  /// Whether subscriptions are enabled on this client (a SubscriptionEscrow address is configured).
  /// When false every subscription method throws a clear "subscriptions disabled" error.
  get subscriptionsEnabled(): boolean {
    return this.cfg.subscriptionEscrow !== undefined;
  }

  /// SELLER: build a SubOffer from human-unit inputs (USD → base-6, durations in seconds). The single
  /// source of truth for subOfferHash — the subId the contract derives in start() equals
  /// subOfferHash(this), so the seller signs exactly what the subscriber funds. Open offer (subscriber
  /// omitted) => the funder becomes the subscriber.
  buildSubOffer(i: SubOfferInput): SubOfferJson {
    const now = Math.floor(Date.now() / 1000);
    return {
      seller: this.address,
      subscriber: i.subscriber ?? ZERO,
      arbiter: i.arbiter,
      token: this.cfg.usdc,
      periodPrice: usd6(i.periodPriceUsd).toString(),
      sellerBond: usd6(i.sellerBondUsd).toString(),
      subscriberBond: usd6(i.subscriberBondUsd).toString(),
      numPeriods: i.numPeriods,
      periodLength: String(i.periodLengthS),
      challengeWindow: String(i.challengeWindowS),
      startAt: String(i.startAt ?? now),
      feeBps: i.feeBps,
      specHash: keccak256(toHex(i.spec)),
      // ms + random suffix: two otherwise-identical sub offers must never collide on subOfferHash (== subId).
      nonce: String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"),
      sigDeadline: String(now + (i.sigTtlS ?? 86_400)),
    };
  }

  /// subOfferHash == subId — identical to what the contract computes in start() (_hashOffer). Derived
  /// under the SubscriptionEscrow EIP-712 domain ("ObulusSubscription", "1"), distinct from the escrow's.
  subOfferHash(offer: SubOfferJson): Hex {
    return hashTypedData({
      domain: this.subDomain(),
      types: SUB_OFFER_TYPE,
      primaryType: "SubOffer",
      message: subOfferToTuple(offer) as never,
    });
  }

  /// SELLER: sign a SubOffer (EIP-712) under the SubscriptionEscrow domain. The signature recovers to
  /// offer.seller, exactly the check start() makes on-chain. Rejects if subscriptions are disabled
  /// (async so the guard surfaces as a rejection, consistent with every other awaited subscription call).
  async signSubOffer(offer: SubOfferJson): Promise<Hex> {
    this.requireSubscriptionEscrow();
    return this.account.signTypedData({
      domain: this.subDomain(),
      types: SUB_OFFER_TYPE,
      primaryType: "SubOffer",
      message: subOfferToTuple(offer) as never,
    });
  }

  /// Verify a seller's SubOffer signature recovers to offer.seller under THIS subscription domain — the
  /// same check start() makes on-chain. Run BEFORE start() so a bad/forged signature fails fast.
  async verifySubOfferSignature(offer: SubOfferJson, signature: Hex): Promise<boolean> {
    try {
      return await verifyTypedData({
        address: offer.seller,
        domain: this.subDomain(),
        types: SUB_OFFER_TYPE,
        primaryType: "SubOffer",
        message: subOfferToTuple(offer) as never,
        signature,
      });
    } catch {
      return false;
    }
  }

  /// SUBSCRIBER: approve (if needed) then start the subscription — prepays numPeriods*periodPrice +
  /// subscriberBond into the contract. subId == subOfferHash(offer). `opts.scopedApproval` (default
  /// false) mirrors fund(): true approves EXACTLY the pulled amount (no standing allowance survives).
  async startSubscription(
    offer: SubOfferJson,
    sellerSig: Hex,
    opts?: { scopedApproval?: boolean },
  ): Promise<{ subId: Hex; txHash: Hex }> {
    this.requireSubscriptionEscrow();
    const pulled = BigInt(offer.periodPrice) * BigInt(offer.numPeriods) + BigInt(offer.subscriberBond);
    await this.ensureSubApproval(pulled, opts);
    const txHash = await this.writeSub("start", [subOfferToTuple(offer), sellerSig]);
    return { subId: this.subOfferHash(offer), txHash };
  }

  /// SELLER: post the sellerBond (approval) and activate the subscription so periods begin accruing.
  /// `sellerBond` is the base-6 amount from the offer (0n => no bond, no approval).
  async activateSubscription(subId: Hex, sellerBond: bigint): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    if (sellerBond > 0n) await this.ensureSubApproval(sellerBond);
    return { txHash: await this.writeSub("activate", [subId]) };
  }

  /// SELLER (permissionless): optimistically release the cursor period to the seller after its challenge
  /// window — periodPrice (minus feeBps) credits the seller.
  async claimPeriod(subId: Hex): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    return { txHash: await this.writeSub("claimPeriod", [subId]) };
  }

  /// SUBSCRIBER: dispute the cursor period (sets it aside, advances the cursor so later periods keep
  /// settling). Pulls a periodPrice anti-grief deposit (refunded if upheld, forfeited if frivolous), so
  /// the contract must be approved for that. Relays the human-readable reason to the Hub (best-effort).
  async disputePeriod(subId: Hex, reason?: string): Promise<{ txHash: Hex; relayed: boolean }> {
    this.requireSubscriptionEscrow();
    const sub = await this.getSub(subId);
    await this.ensureSubApproval(sub.periodPrice);
    const txHash = await this.writeSub("disputePeriod", [subId]);
    const relayed = reason === undefined ? false : await this.tryHub("POST", "/relay/dispute", { subId, reason });
    return { txHash, relayed };
  }

  /// ARBITER only: split a set-aside period's price between seller/subscriber. `sellerBps` = seller's
  /// share of the period price (0..10000). Identify the disputed period by its index.
  async resolvePeriod(subId: Hex, period: number, sellerBps: number): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    return { txHash: await this.writeSub("resolvePeriod", [subId, period, sellerBps]) };
  }

  /// Permissionless absent-arbiter fallback: after the resolve timeout, settle a set-aside period as a
  /// neutral 50/50 split (deposit refunded to the subscriber).
  async resolvePeriodExpired(subId: Hex, period: number): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    return { txHash: await this.writeSub("resolvePeriodExpired", [subId, period]) };
  }

  /// SUBSCRIBER: cancel the remaining (non-disputed) periods — fully-served periods pay the seller, the
  /// UNCONSUMED periods refund to the subscriber. Set-aside disputes are unaffected; bonds return at close.
  async revokeSubscription(subId: Hex): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    return { txHash: await this.writeSub("revoke", [subId]) };
  }

  /// Permissionless liveness backstop: once the whole subscription is long over, force-settle the
  /// not-yet-handled periods (served → seller, the rest → subscriber) so funds can never freeze.
  async expireSubscription(subId: Hex): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    return { txHash: await this.writeSub("expireSub", [subId]) };
  }

  /// Return the remaining bonds to their owners once every period is settled (reverts if disputes pend).
  async closeSubscription(subId: Hex): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    return { txHash: await this.writeSub("close", [subId]) };
  }

  /// Pull-payment on the SubscriptionEscrow: move this agent's credited subscription balance to its
  /// wallet. Distinct from the single-Escrow withdraw() (separate contract, separate credit ledger).
  async withdrawSubscription(): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    return { txHash: await this.writeSub("withdraw", []) };
  }

  /// SELLER: invalidate an un-started sub offer by its nonce (so a leaked signature can't be funded).
  async cancelSubOffer(nonce: string | bigint): Promise<{ txHash: Hex }> {
    this.requireSubscriptionEscrow();
    return { txHash: await this.writeSub("cancelOffer", [BigInt(nonce)]) };
  }

  // ── subscription reads ──────────────────────────────────────────────────────

  /// Decoded SubscriptionEscrow.getSub() struct for `subId`.
  async getSub(subId: Hex): Promise<OnchainSub> {
    const sub = this.requireSubscriptionEscrow();
    return (await this.pub.readContract({ address: sub, abi: subscriptionEscrowAbi, functionName: "getSub", args: [subId] })) as OnchainSub;
  }

  /// A compact lifecycle snapshot of a subscription: the State plus the cursor/settled/pending counts.
  /// `pending` = periods set aside under a still-pending dispute (delays close).
  async subStatus(subId: Hex): Promise<{
    state: number;
    activated: boolean;
    numPeriods: number;
    cursor: number;
    settledCount: number;
    pending: number;
  }> {
    const s = await this.getSub(subId);
    return {
      state: s.state,
      activated: s.activated,
      numPeriods: s.numPeriods,
      cursor: s.cursor,
      settledCount: s.settledCount,
      pending: s.cursor - s.settledCount,
    };
  }

  /// This agent's withdrawable credit on the SubscriptionEscrow (separate ledger from the escrow's).
  async subCredits(of: Address = this.address): Promise<bigint> {
    const sub = this.requireSubscriptionEscrow();
    return (await this.pub.readContract({ address: sub, abi: subscriptionEscrowAbi, functionName: "credits", args: [of] })) as bigint;
  }

  // ── subscription internals ──────────────────────────────────────────────────

  /// EIP-712 domain for the SubscriptionEscrow — distinct name from the single Escrow ("Obulus"),
  /// so a SubOffer signature can never be replayed against the single-escrow contract (and vice versa).
  private subDomain() {
    return { name: "ObulusSubscription", version: "1", chainId: this.cfg.chainId, verifyingContract: this.requireSubscriptionEscrow() };
  }

  private requireSubscriptionEscrow(): Address {
    if (!this.cfg.subscriptionEscrow) throw new Error("subscriptions disabled — no subscriptionEscrow address configured on this AgentClient");
    return this.cfg.subscriptionEscrow;
  }

  /// Approve the SubscriptionEscrow as USDC spender for `amount`. Same scoped/infinite discipline as
  /// ensureApproval (the escrow path), but the spender is the SubscriptionEscrow contract.
  private async ensureSubApproval(amount: bigint, opts?: { scopedApproval?: boolean }): Promise<void> {
    const spender = this.requireSubscriptionEscrow();
    const allowance = (await this.pub.readContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [this.address, spender] })) as bigint;
    if (opts?.scopedApproval) {
      if (allowance === amount) return;
      await this.approveSpender(spender, amount);
      return;
    }
    if (allowance >= amount) return;
    await this.approveSpender(spender, maxUint256);
  }

  /// Submit a USDC approve(spender, value) and require the tx to mine successfully (generic spender).
  private async approveSpender(spender: Address, value: bigint): Promise<void> {
    const txHash = await this.wallet.writeContract({ address: this.cfg.usdc, abi: erc20Abi, functionName: "approve", args: [spender, value], chain: this.wallet.chain, account: this.account });
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`approve reverted (${txHash})`);
  }

  /// Like write(), but against the SubscriptionEscrow address + ABI. A mined revert throws.
  private async writeSub(functionName: string, args: readonly unknown[]): Promise<Hex> {
    const sub = this.requireSubscriptionEscrow();
    const txHash = await this.wallet.writeContract({
      address: sub,
      abi: subscriptionEscrowAbi,
      functionName: functionName as never,
      args: args as never,
      chain: this.wallet.chain,
      account: this.account,
    } as never);
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${txHash})`);
    return txHash;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private cfgUsdc(): Address {
    return this.cfg.usdc;
  }
  private cfgEscrow(): Address {
    return this.cfg.escrow;
  }
  private cfgChainId(): number {
    return this.cfg.chainId;
  }
  /// Human-friendly x402 network label for known chains; the chainId string otherwise.
  private networkLabel(): string {
    return this.cfg.chainId === 46630 ? "robinhood-testnet" : this.cfg.chainId === 4663 ? "robinhood" : String(this.cfg.chainId);
  }

  private async write(functionName: string, args: readonly unknown[]): Promise<Hex> {
    const txHash = await this.wallet.writeContract({
      address: this.cfg.escrow,
      abi: escrowAbi,
      functionName: functionName as never,
      args: args as never,
      chain: this.wallet.chain,
      account: this.account,
    } as never);
    // Bounded wait: on a slow public network a stuck tx must surface as a failure (→ scenario
    // backoff in the bot runner), not hang the agent forever.
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${txHash})`);
    return txHash;
  }

  private async hub(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.cfg.hubUrl) throw new Error(`hubUrl not configured — cannot call ${path}`);
    const res = await this.boundedFetch(this.cfg.hubUrl.replace(/\/$/, "") + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, `hub ${method} ${path}`);
    if (!res.ok) throw new Error(`hub ${method} ${path} → ${res.status} ${await res.text().catch(() => "")}`);
    return res.json().catch(() => undefined);
  }

  /// fetch() with the SDK-wide HTTP bound (cfg.httpTimeoutMs, default 15s). Node's fetch has NO
  /// default timeout, and both the x402 seller endpoint and the Hub are remote/untrusted surfaces:
  /// a hung endpoint must surface as a clear error, never stall the sequential agent forever.
  private async boundedFetch(url: string, init: RequestInit, what: string): Promise<Response> {
    const ms = this.cfg.httpTimeoutMs ?? 15_000;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new Error(`${what} timed out after ${ms}ms (${url})`);
      throw e;
    }
  }

  /// Best-effort hub call (2 attempts): the chain is the source of truth, the relay is content-only.
  private async tryHub(method: string, path: string, body?: unknown): Promise<boolean> {
    for (let i = 0; i < 2; i++) {
      try {
        await this.hub(method, path, body);
        return true;
      } catch { /* retry once */ }
    }
    return false;
  }
}
