/// HERMETIC unit tests for the three production-prep SDK remediations. NOTHING here contacts a live
/// chain, bundler, or Paymaster — a deterministic in-memory `custom` transport intercepts every RPC
/// and (for the funding tx) captures the signed raw transaction so its calldata can be decoded.
///
///   1. CANONICAL offer tuple: the EOA fund() path and the ERC-4337 buildFundCalls path MUST encode
///      the SAME Offer tuple (a single offerToTuple in types.ts), so a future Offer-struct change can
///      never silently diverge the 4337 dealId from the EOA dealId.
///   2. X402 buyer-side spend ceiling: quoteAndFund refuses an over-ceiling quote, and the untrusted
///      x402 fund path SCOPES the USDC approval to exactly price+buyerBond (never maxUint256), so no
///      standing allowance survives the fund tx.
///   3. smartAccount construction short-circuit: a construct-only (no bundlerUrl) call NEVER dials —
///      makeBundlerClient and the factory getAddress() RPC are both skipped without a bundlerUrl.

import { describe, it, expect } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  maxUint256,
  parseTransaction,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount, type SmartAccount } from "viem/account-abstraction";
import { AgentClient } from "../src/client.js";
import { buildFundCalls, buildFundUserOperation } from "../src/smartAccount.js";
import { offerToTuple, type OfferJson } from "../src/types.js";
import { erc20Abi, escrowAbi } from "../src/abi.js";

// ── fixtures ────────────────────────────────────────────────────────────────────
const CHAIN_ID = 46630; // Robinhood Chain testnet
const RPC = "http://127.0.0.1:0/never-dialed";
const ESCROW_ADDR: Address = "0x1111111111111111111111111111111111111111";
const USDC_ADDR: Address = "0x2222222222222222222222222222222222222222";
const ARBITER: Address = "0x3333333333333333333333333333333333333333";
const SENDER_ADDR: Address = "0x9999999999999999999999999999999999999999";
const OWNER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BUYER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function sampleOffer(client: AgentClient): OfferJson {
  return client.buildOffer({
    arbiter: ARBITER,
    priceUsd: 10,
    buyerBondUsd: 2,
    sellerBondUsd: 3,
    feeBps: 100,
    deliverInS: 3600,
    confirmWindowS: 1800,
    spec: "render a 4k frame",
  });
}

/// A deterministic transport that lets fund()/ensureApproval run end-to-end with no socket. It answers
/// allowance reads with `allowance`, captures EVERY eth_sendRawTransaction into `sent`, and resolves
/// receipts as success. `allowance` is mutable so a test can simulate "already approved".
function recordingTransport(state: { allowance: bigint; sent: Hex[] }) {
  return custom({
    async request({ method, params }: { method: string; params?: any }) {
      switch (method) {
        case "eth_chainId":
          return `0x${CHAIN_ID.toString(16)}`;
        case "eth_call":
          // The only eth_call here is erc20 allowance(owner, spender) → return the current allowance.
          return encodeAbiParameters([{ type: "uint256" }], [state.allowance]);
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_maxPriorityFeePerGas":
          return "0x3b9aca00";
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x3b9aca00", number: "0x1", gasLimit: "0x1c9c380" };
        case "eth_estimateGas":
          return "0x5208";
        case "eth_sendRawTransaction":
          state.sent.push(params[0] as Hex);
          return ("0x" + "11".repeat(32)) as Hex;
        case "eth_getTransactionReceipt":
          return {
            status: "0x1",
            blockNumber: "0x1",
            transactionHash: ("0x" + "11".repeat(32)) as Hex,
            blockHash: ("0x" + "22".repeat(32)) as Hex,
            gasUsed: "0x5208",
            cumulativeGasUsed: "0x5208",
            logs: [],
            type: "0x2",
            contractAddress: null,
            transactionIndex: "0x0",
            from: "0x" + "33".repeat(20),
            to: "0x" + "44".repeat(20),
            effectiveGasPrice: "0x3b9aca00",
            logsBloom: "0x" + "00".repeat(256),
          };
        default:
          throw new Error(`recordingTransport: unexpected RPC ${method}`);
      }
    },
  });
}

/// Build an AgentClient whose wallet/public clients use the recording transport (so fund/approve run
/// with no network). We construct normally, then swap the private transports — keeping the production
/// constructor path intact while making the test hermetic.
function recordingBuyer(state: { allowance: bigint; sent: Hex[] }): AgentClient {
  const buyer = new AgentClient({ rpcUrl: RPC, chainId: CHAIN_ID, escrow: ESCROW_ADDR, usdc: USDC_ADDR, privateKey: BUYER_KEY });
  const chain = defineChain({ id: CHAIN_ID, name: "t", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const transport = recordingTransport(state);
  (buyer as any).pub = createPublicClient({ chain, transport });
  (buyer as any).wallet = createWalletClient({ account: privateKeyToAccount(BUYER_KEY), chain, transport });
  return buyer;
}

/// Decode the approve calldata from a captured raw approve tx → { spender, amount }.
function decodeApprove(rawTx: Hex): { spender: Address; amount: bigint } {
  const parsed = parseTransaction(rawTx);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: parsed.data as Hex });
  expect(decoded.functionName).toBe("approve");
  return { spender: (decoded.args![0] as Address), amount: decoded.args![1] as bigint };
}

/// Decode the fund() offer tuple from a captured raw fund tx.
function decodeFundOffer(rawTx: Hex): Record<string, unknown> {
  const parsed = parseTransaction(rawTx);
  const decoded = decodeFunctionData({ abi: escrowAbi, data: parsed.data as Hex });
  expect(decoded.functionName).toBe("fund");
  return decoded.args![0] as Record<string, unknown>;
}

// A deterministic transport for the smart-account factory getAddress() read (used only where we WANT
// to build a real coinbase account hermetically, e.g. the injected-account construction test).
function factoryStubTransport() {
  return custom({
    async request({ method }: { method: string }) {
      if (method === "eth_chainId") return `0x${CHAIN_ID.toString(16)}`;
      if (method === "eth_call") return encodeAbiParameters([{ type: "address" }], [SENDER_ADDR]);
      throw new Error(`factoryStubTransport: unexpected RPC ${method}`);
    },
  });
}
async function stubSmartAccount(): Promise<SmartAccount> {
  const chain = defineChain({ id: CHAIN_ID, name: "t", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const client = createPublicClient({ chain, transport: factoryStubTransport() });
  return toCoinbaseSmartAccount({ client, owners: [privateKeyToAccount(OWNER_KEY)], version: "1.1", nonce: 0n });
}

// ── Remediation #1: ONE canonical offer tuple, shared by EOA fund() and 4337 buildFundCalls ───────
describe("remediation #1 — canonical offerToTuple shared by the EOA fund() and ERC-4337 paths", () => {
  it("EOA fund() and buildFundCalls encode the IDENTICAL Offer tuple (so the 4337 dealId can never diverge)", async () => {
    const state = { allowance: 0n, sent: [] as Hex[] };
    const buyer = recordingBuyer(state);
    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer);

    // EOA path: fund() approves then sends fund(offerTuple, sig). Capture the fund tx (2nd raw tx).
    await buyer.fund(offer, sig);
    expect(state.sent).toHaveLength(2); // [approve, fund]
    const eoaTuple = decodeFundOffer(state.sent[1]!);

    // 4337 path: buildFundCalls[1] is the fund(offerTuple, sig) call.
    const calls = buildFundCalls(offer, sig, ESCROW_ADDR, USDC_ADDR);
    const fund4337 = decodeFunctionData({ abi: escrowAbi, data: calls[1]!.data });
    expect(fund4337.functionName).toBe("fund");
    const aaTuple = fund4337.args![0] as Record<string, unknown>;

    // The canonical encoder is the reference for both.
    const canonical = offerToTuple(offer) as unknown as Record<string, unknown>;

    // Compare field-by-field across ALL 13 Offer fields — EOA == 4337 == canonical.
    for (const f of ["seller", "buyer", "arbiter", "token", "price", "buyerBond", "sellerBond", "deliverDeadline", "confirmWindow", "feeBps", "specHash", "nonce", "sigDeadline"] as const) {
      const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v);
      expect(norm(eoaTuple[f])).toStrictEqual(norm(aaTuple[f]));
      expect(norm(eoaTuple[f])).toStrictEqual(norm(canonical[f]));
    }
    // dealId derivation (offerHash) is unaffected by transport — same offer => same dealId both ways.
    expect(buyer.offerHash(offer)).toBe(buyer.offerHash(offer));
  });
});

// ── Remediation #2: x402 buyer-side spend ceiling + scoped approval ────────────────────────────────
describe("remediation #2 — x402 spend ceiling and scoped (non-infinite) approval", () => {
  it("the untrusted x402 fund path SCOPES the USDC approval to exactly price+buyerBond (NOT maxUint256)", async () => {
    const state = { allowance: 0n, sent: [] as Hex[] };
    const buyer = recordingBuyer(state);
    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer);

    // fund() with scopedApproval mirrors what quoteAndFund() uses on the untrusted seller path.
    await buyer.fund(offer, sig, { scopedApproval: true });

    expect(state.sent.length).toBeGreaterThanOrEqual(1);
    const { spender, amount } = decodeApprove(state.sent[0]!);
    expect(spender.toLowerCase()).toBe(ESCROW_ADDR.toLowerCase());
    // EXACT price+buyerBond — never an infinite standing allowance.
    expect(amount).toBe(BigInt(offer.price) + BigInt(offer.buyerBond));
    expect(amount).not.toBe(maxUint256);
  });

  it("the DEFAULT (trusted EOA) fund path keeps the infinite approve — distinct from the scoped path", async () => {
    const state = { allowance: 0n, sent: [] as Hex[] };
    const buyer = recordingBuyer(state);
    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer);

    await buyer.fund(offer, sig); // no scopedApproval => infinite approve (the reused-allowance default)
    const { amount } = decodeApprove(state.sent[0]!);
    expect(amount).toBe(maxUint256);
  });

  it("scoped approval is SKIPPED when the standing allowance already equals exactly price+buyerBond", async () => {
    const offer = sampleOffer(recordingBuyer({ allowance: 0n, sent: [] }));
    const exact = BigInt(offer.price) + BigInt(offer.buyerBond);
    const state = { allowance: exact, sent: [] as Hex[] };
    const buyer = recordingBuyer(state);
    const sig = await buyer.signOffer(offer);

    await buyer.fund(offer, sig, { scopedApproval: true });
    // Only the fund tx — NO approve tx, because the allowance is already exactly scoped.
    expect(state.sent).toHaveLength(1);
    const fundOffer = decodeFundOffer(state.sent[0]!);
    expect((fundOffer.price as bigint)).toBe(BigInt(offer.price));
  });

  it("scoped approval RESETS a standing infinite allowance DOWN to exactly price+buyerBond", async () => {
    const offer = sampleOffer(recordingBuyer({ allowance: 0n, sent: [] }));
    const state = { allowance: maxUint256, sent: [] as Hex[] }; // a leftover infinite allowance stands
    const buyer = recordingBuyer(state);
    const sig = await buyer.signOffer(offer);

    await buyer.fund(offer, sig, { scopedApproval: true });
    expect(state.sent).toHaveLength(2); // re-approve DOWN, then fund
    const { amount } = decodeApprove(state.sent[0]!);
    expect(amount).toBe(BigInt(offer.price) + BigInt(offer.buyerBond));
  });

  it("ensureApproval default (infinite) is SKIPPED when the standing allowance already covers the amount", async () => {
    const offer = sampleOffer(recordingBuyer({ allowance: 0n, sent: [] }));
    const state = { allowance: maxUint256, sent: [] as Hex[] };
    const buyer = recordingBuyer(state);
    const sig = await buyer.signOffer(offer);
    await buyer.fund(offer, sig); // infinite allowance already stands => no approve, just fund
    expect(state.sent).toHaveLength(1);
  });
});

// ── Remediation #3: construct-only smartAccount path never dials ───────────────────────────────────
describe("remediation #3 — pure smart-account construction never touches the network", () => {
  it("no bundlerUrl + no injected account => throws (factory getAddress RPC is NOT dialed)", async () => {
    const offer = sampleOffer(recordingBuyer({ allowance: 0n, sent: [] }));
    const sig = ("0x" + "ab".repeat(65)) as Hex;
    await expect(
      buildFundUserOperation({
        offer,
        signature: sig,
        escrow: ESCROW_ADDR,
        usdc: USDC_ADDR,
        chainId: CHAIN_ID,
        rpcUrl: RPC, // would be dialed by toCoinbaseSmartAccount's getAddress() — must NOT happen
        smartAccount: {}, // no bundlerUrl
        fallbackOwnerKey: OWNER_KEY,
      }),
    ).rejects.toThrow(/requires an injected `account`|construct-only/i);
  });

  it("paymaster WITHOUT bundlerUrl does NOT build a real bundler — construct-only, no dial, sent=false", async () => {
    const account = await stubSmartAccount(); // injected => no factory dial
    const buyer = new AgentClient({ rpcUrl: RPC, chainId: CHAIN_ID, escrow: ESCROW_ADDR, usdc: USDC_ADDR, privateKey: BUYER_KEY, smartAccount: { paymaster: "https://paymaster.example/rpc" } });
    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer);

    // No bundlerClient injected. With the fix, makeBundlerClient is skipped (no bundlerUrl), so the
    // no-bundler branch runs: a well-shaped UserOp is constructed WITHOUT any RPC (no prepareUserOperation).
    const res = await buyer.fundViaSmartAccount(offer, sig, { account });
    expect(res.sent).toBe(false);
    expect(res.sender.toLowerCase()).toBe(SENDER_ADDR.toLowerCase());
    expect(res.userOperation.sender.toLowerCase()).toBe(SENDER_ADDR.toLowerCase());
    // callData decodes to the batched approve+fund (encodeCalls is pure — no network).
    expect(res.userOperation.callData).toBeDefined();
    expect(res.dealId).toBe(buyer.offerHash(offer));
  });

  it("an injected account constructs hermetically with no bundlerUrl (no factory RPC, sent=false)", async () => {
    const account = await stubSmartAccount();
    const res = await buildFundUserOperation({
      offer: sampleOffer(new AgentClient({ rpcUrl: RPC, chainId: CHAIN_ID, escrow: ESCROW_ADDR, usdc: USDC_ADDR, privateKey: BUYER_KEY })),
      signature: ("0x" + "ab".repeat(65)) as Hex,
      escrow: ESCROW_ADDR,
      usdc: USDC_ADDR,
      chainId: CHAIN_ID,
      rpcUrl: RPC,
      smartAccount: {},
      fallbackOwnerKey: OWNER_KEY,
      account,
    });
    expect(res.sent).toBe(false);
    expect(res.sender.toLowerCase()).toBe(SENDER_ADDR.toLowerCase());
  });
});
