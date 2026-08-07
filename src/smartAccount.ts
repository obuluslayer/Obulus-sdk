/// OPTIONAL ERC-4337 smart-account transport for the funding flow.
///
/// This is an OPT-IN alternative to the DEFAULT EOA path in AgentClient. It is built ENTIRELY on
/// viem's NATIVE account-abstraction module (`viem/account-abstraction`) — no `permissionless` or
/// other heavy dependency is added (the installed viem ships toCoinbaseSmartAccount,
/// createBundlerClient and prepareUserOperation/sendUserOperation).
///
/// The funding action is a SINGLE batched UserOperation against a Coinbase Smart Wallet:
///   call[0] = USDC.approve(escrow, price + buyerBond)
///   call[1] = Escrow.fund(offer, sellerSig)
/// with the Paymaster sponsoring gas (gasless from the agent's perspective).
///
/// dealId is NEVER touched by this transport — the caller still derives it from offerHash(offer),
/// so buildOffer/offerHash stays the single source of truth and the dealId is identical whether the
/// deal is funded over the EOA path or this smart-account path.
///
/// IMPORTANT — what is and is NOT exercised by tests: the UserOperation CONSTRUCTION (sender derived
/// from the smart account, batched callData, paymaster fields) is fully unit-tested with a stubbed
/// bundler. The actual gasless SEND (UserOp -> Paymaster -> Bundler -> on-chain) requires a live
/// bundler RPC + funded Paymaster + a deployed Smart Wallet factory on Robinhood Chain (official AA infra: Alchemy/ZeroDev bundlers — docs.robinhood.com/chain/account-abstraction) and CANNOT be
/// validated by automated tests; the send path is gated behind a configured bundlerUrl.

import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createBundlerClient,
  createPaymasterClient,
  toCoinbaseSmartAccount,
  type BundlerClient,
  type SmartAccount,
  type UserOperation,
} from "viem/account-abstraction";
import { erc20Abi, escrowAbi } from "./abi.js";
import { offerToTuple, type OfferJson } from "./types.js";

/// OPT-IN smart-account (ERC-4337) configuration. When ABSENT on AgentConfig, the smart-account
/// transport is DISABLED and AgentClient uses the EOA path (the default). Every field is optional so
/// a partial config still type-checks; the runtime enforces what each operation actually needs:
///   - ownerKey   : the smart account OWNER (the EOA that signs UserOps for the Coinbase Smart Wallet).
///                  Absent => falls back to AgentConfig.privateKey, so a smartAccount:{} block is enough
///                  to opt in to the smart-account transport with the agent's own key as the owner.
///   - bundlerUrl : the ERC-4337 bundler RPC. CONSTRUCTION never needs it; only the SEND path is gated
///                  on it (absent => fundViaSmartAccount stops at a constructed-but-unsent UserOperation).
///   - paymaster  : a Paymaster SERVICE URL that sponsors gas. When set, the bundler client requests
///                  paymaster data so the produced UserOp carries paymaster fields (gasless).
///   - version    : Coinbase Smart Wallet implementation version (default "1.1").
///   - factoryNonce: the smart-account factory salt/nonce that selects which counterfactual wallet
///                   address this owner controls (default 0n).
export interface SmartAccountConfig {
  ownerKey?: Hex;
  bundlerUrl?: string;
  /// Paymaster service URL (sponsorship endpoint) OR `true` to use the bundler's own paymaster RPC.
  paymaster?: string | true;
  paymasterContext?: unknown;
  version?: "1" | "1.1";
  factoryNonce?: bigint;
}

/// The SHAPE the funding builder returns. `sent` is true only when a bundler was configured AND the
/// UserOp was submitted; otherwise the UserOperation was CONSTRUCTED but not sent (no live bundler).
export interface FundUserOpResult {
  /// dealId == offerHash(offer): identical to the EOA path. Filled in by AgentClient (kept here as a
  /// convenience for callers that use the builder directly).
  dealId?: Hex;
  /// The smart-account (sender) address — the counterfactual Coinbase Smart Wallet for this owner.
  sender: Address;
  /// The batched calls that callData encodes: [approve USDC -> escrow, fund -> escrow].
  calls: readonly { to: Address; value: bigint; data: Hex }[];
  /// The fully-constructed (but possibly unsent) UserOperation. Always present.
  userOperation: PreparedUserOperation;
  /// True only when a bundler was configured and the UserOp was actually submitted.
  sent: boolean;
  /// Present only when `sent` is true.
  userOpHash?: Hex;
}

/// A prepared UserOperation as produced by viem's prepareUserOperation (v0.7 entrypoint fields).
/// We keep this loose (Partial of the v0.7 UserOperation) because, without a live bundler, gas and
/// nonce fields may be left for the bundler to fill — but sender + callData are ALWAYS present.
export type PreparedUserOperation = Partial<UserOperation<"0.7">> & {
  sender: Address;
  callData: Hex;
};

/// Build the two funding calls (approve + fund) for an offer. Pure & deterministic: no I/O. This is
/// what gets batched into the smart account's executeBatch callData. Kept separate so a test can
/// assert the targets/selectors/args WITHOUT constructing a smart account or contacting any RPC.
/// TRUSTED-INPUT-ONLY: like fund(), this performs NO arbiter/window/ceiling checks on the offer —
/// route untrusted-seller quotes through AgentClient.quoteAndFund() (EOA) and vet terms yourself
/// before building a gasless UserOperation from them.
///   call[0] = USDC.approve(escrow, price + buyerBond)
///   call[1] = Escrow.fund(offerTuple, sellerSig)
export function buildFundCalls(
  offer: OfferJson,
  signature: Hex,
  escrow: Address,
  usdc: Address,
): readonly { to: Address; value: bigint; data: Hex }[] {
  const total = BigInt(offer.price) + BigInt(offer.buyerBond);
  return [
    {
      to: usdc,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [escrow, total] }),
    },
    {
      to: escrow,
      value: 0n,
      data: encodeFunctionData({ abi: escrowAbi, functionName: "fund", args: [offerToTuple(offer), signature] as never }),
    },
  ];
}

/// Inputs to the funding-UserOperation builder. `bundlerClient` is injectable so tests can pass a
/// stub that resolves prepareUserOperation/sendUserOperation deterministically WITHOUT a live bundler.
export interface BuildFundUserOpArgs {
  offer: OfferJson;
  signature: Hex;
  escrow: Address;
  usdc: Address;
  chainId: number;
  rpcUrl: string;
  smartAccount: SmartAccountConfig;
  /// Falls back to the agent's own private key when smartAccount.ownerKey is absent.
  fallbackOwnerKey: Hex;
  /// Optional injected bundler client (tests). When omitted and bundlerUrl is set, one is created.
  bundlerClient?: MinimalBundlerClient;
  /// Optional injected smart account (tests). When omitted, one is created via toCoinbaseSmartAccount.
  account?: InjectableSmartAccount;
}

/// A viem SmartAccount, injectable into the builder so a test can supply a pre-built account whose
/// counterfactual address is fixed — avoiding the factory getAddress() RPC entirely (kept hermetic).
export type InjectableSmartAccount = SmartAccount;

/// The minimal slice of viem's BundlerClient this builder uses — narrow surface so a test stub only
/// has to implement prepareUserOperation/sendUserOperation.
export interface MinimalBundlerClient {
  prepareUserOperation: (args: {
    account: SmartAccount;
    calls: readonly { to: Address; value: bigint; data: Hex }[];
  }) => Promise<PreparedUserOperation>;
  sendUserOperation?: (args: {
    account: SmartAccount;
    calls: readonly { to: Address; value: bigint; data: Hex }[];
  }) => Promise<Hex>;
}

/// Build (and, only when a bundler is configured, send) the gasless funding UserOperation.
///
/// CONSTRUCTION-vs-SEND boundary — and the HERMETIC guarantee:
/// The SEND path is gated on smartAccount.bundlerUrl; the real gasless send needs a live bundler RPC +
/// funded Paymaster + deployed factory on Robinhood Chain. Pure CONSTRUCTION (no bundlerUrl) must NEVER
/// touch the network. Two network surfaces are involved and BOTH are gated on bundlerUrl here:
///   - makeBundlerClient is only built when bundlerUrl is set. A paymaster-WITHOUT-bundlerUrl config
///     no longer builds a real bundler/paymaster client (prepareUserOperation over RPC) — there is no
///     bundler to send to, so building one only to discard it would have dialed for nothing.
///   - toCoinbaseSmartAccount resolves the counterfactual sender via a factory getAddress() readContract
///     DURING construction (viem's toSmartAccount awaits getAddress()). That RPC is only made when a
///     bundlerUrl is configured. Without a bundlerUrl the caller MUST inject `args.account` (the SDK's
///     fundViaSmartAccount tests do); otherwise we throw a clear error instead of silently dialing.
///
/// So: bundlerUrl absent + no injected account => no dial, clear error. bundlerUrl absent + injected
/// account => no dial, returns a constructed-but-unsent UserOp. bundlerUrl present => real infra path.
export async function buildFundUserOperation(args: BuildFundUserOpArgs): Promise<FundUserOpResult> {
  const { offer, signature, escrow, usdc, smartAccount } = args;
  const hasBundlerUrl = Boolean(smartAccount.bundlerUrl);

  const chain: Chain = defineChain({
    id: args.chainId,
    name: `chain-${args.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [args.rpcUrl] } },
  });
  const transport: Transport = http(args.rpcUrl, { retryCount: 1, retryDelay: 400, timeout: 12_000 });
  const publicClient: PublicClient = createPublicClient({ chain, transport });

  // Build the smart account ONLY when it won't dial. toCoinbaseSmartAccount awaits a factory getAddress()
  // RPC at construction, so we only call it when a bundlerUrl is configured (the send path needs the live
  // address anyway). Without a bundlerUrl an injected account is REQUIRED — pure construction never dials.
  let account: SmartAccount;
  if (args.account) {
    account = args.account;
  } else if (hasBundlerUrl) {
    const owner: Account = privateKeyToAccount(smartAccount.ownerKey ?? args.fallbackOwnerKey);
    account = await toCoinbaseSmartAccount({
      client: publicClient,
      owners: [owner],
      version: smartAccount.version ?? "1.1",
      nonce: smartAccount.factoryNonce ?? 0n,
    });
  } else {
    throw new Error(
      "buildFundUserOperation: no bundlerUrl configured (construct-only) requires an injected `account` — " +
        "resolving the counterfactual smart-account address would dial the factory getAddress() RPC. " +
        "Set smartAccount.bundlerUrl to send, or pass opts.account to construct hermetically.",
    );
  }

  const calls = buildFundCalls(offer, signature, escrow, usdc);

  // The bundler client carries the paymaster wiring; prepareUserOperation populates paymaster fields when
  // a paymaster is configured. It is ONLY built when a bundlerUrl is set (no bundler => no network), so a
  // construct-only call never dials. A test can still inject a stub bundler regardless of bundlerUrl.
  const bundler: MinimalBundlerClient | undefined =
    args.bundlerClient ?? (hasBundlerUrl ? makeBundlerClient(publicClient, chain, smartAccount) : undefined);

  if (!bundler) {
    // No bundler → CONSTRUCT a minimal typed UserOp (sender + batched callData) without any network call.
    const callData = await account.encodeCalls(calls);
    return {
      sender: account.address,
      calls,
      userOperation: { sender: account.address, callData },
      sent: false,
    };
  }

  const userOperation = await bundler.prepareUserOperation({ account, calls });
  // Guarantee sender/callData are present even if a stub omitted them.
  userOperation.sender ??= account.address;
  if (!userOperation.callData) userOperation.callData = await account.encodeCalls(calls);

  // SEND is gated on a configured bundlerUrl AND a usable sendUserOperation. Absent => stop here.
  if (!hasBundlerUrl || typeof bundler.sendUserOperation !== "function") {
    return { sender: account.address, calls, userOperation, sent: false };
  }

  const userOpHash = await bundler.sendUserOperation({ account, calls });
  return { sender: account.address, calls, userOperation, sent: true, userOpHash };
}

/// Create a real viem BundlerClient (only used when NOT injected and a bundlerUrl IS configured — the
/// caller gates on that, so this never builds a network client for a construct-only call). When a
/// paymaster URL is given it is wired as the paymaster transport so prepareUserOperation requests
/// sponsorship; `true` reuses the bundler's own RPC for paymaster methods.
function makeBundlerClient(
  publicClient: PublicClient,
  chain: Chain,
  smartAccount: SmartAccountConfig,
): MinimalBundlerClient | undefined {
  if (!smartAccount.bundlerUrl) return undefined; // never dial without a bundler to talk to
  const bundlerTransport: Transport = http(smartAccount.bundlerUrl, { retryCount: 1, timeout: 12_000 });

  // paymaster: a service URL => a dedicated PaymasterClient (exposes getPaymasterData/StubData so the
  // bundler requests sponsorship); `true` => the bundler's own RPC also serves paymaster methods.
  const paymaster =
    typeof smartAccount.paymaster === "string"
      ? createPaymasterClient({ transport: http(smartAccount.paymaster, { retryCount: 1, timeout: 12_000 }) })
      : smartAccount.paymaster === true
        ? true
        : undefined;

  const client = createBundlerClient({
    client: publicClient,
    chain,
    transport: bundlerTransport,
    ...(paymaster ? { paymaster } : {}),
    ...(smartAccount.paymasterContext !== undefined ? { paymasterContext: smartAccount.paymasterContext } : {}),
  }) as unknown as BundlerClient;

  return client as unknown as MinimalBundlerClient;
}

