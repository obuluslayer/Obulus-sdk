/// HERMETIC unit tests for the OPT-IN ERC-4337 smart-account funding transport.
///
/// NOTHING here contacts a live bundler, Paymaster, or chain:
///   - the only RPC the Coinbase smart account needs (factory getAddress -> counterfactual sender) is
///     served by a deterministic in-memory `custom` transport (no network),
///   - the bundler is a STUB whose prepareUserOperation/sendUserOperation resolve synchronously.
/// The tests assert the UserOperation is correctly SHAPED (sender, batched approve+fund callData to the
/// right targets/args, paymaster fields when configured) and STOP AT CONSTRUCTION — they never require
/// a real bundler. They also prove the EOA path is the DEFAULT when no smartAccount config is present.

import { describe, it, expect, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount, type SmartAccount } from "viem/account-abstraction";
import { custom, createPublicClient, defineChain } from "viem";
import { AgentClient } from "../src/client.js";
import { buildFundCalls } from "../src/smartAccount.js";
import { erc20Abi, escrowAbi } from "../src/abi.js";

// ── fixtures ──────────────────────────────────────────────────────────────────
const CHAIN_ID = 46630; // Robinhood Chain testnet
const RPC = "http://127.0.0.1:0/never-dialed"; // never actually dialed (custom transport intercepts)
const ESCROW_ADDR: Address = "0x1111111111111111111111111111111111111111";
const USDC_ADDR: Address = "0x2222222222222222222222222222222222222222";
const ARBITER: Address = "0x3333333333333333333333333333333333333333";
// Deterministic counterfactual smart-account address the stub factory "returns".
const SENDER_ADDR: Address = "0x9999999999999999999999999999999999999999";
// A funded test private key (anvil account #0) — only used to derive an owner account locally.
const OWNER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BUYER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/// A deterministic transport: answers eth_chainId and serves the factory getAddress() read with a
/// fixed counterfactual address. No socket is ever opened.
function stubTransport() {
  return custom({
    async request({ method }: { method: string; params?: unknown }) {
      if (method === "eth_chainId") return `0x${CHAIN_ID.toString(16)}`;
      if (method === "eth_call") {
        // factory.getAddress(owners, nonce) returns a single address (abi-encoded, 32-byte padded).
        return encodeAbiParameters([{ type: "address" }], [SENDER_ADDR]);
      }
      throw new Error(`stubTransport: unexpected RPC ${method}`);
    },
  });
}

/// Build a real Coinbase smart account whose getAddress() resolves via the stub transport (so its
/// .address === SENDER_ADDR with no network).
async function stubSmartAccount(): Promise<SmartAccount> {
  const chain = defineChain({
    id: CHAIN_ID,
    name: "robinhood-testnet-test",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const client = createPublicClient({ chain, transport: stubTransport() });
  return toCoinbaseSmartAccount({ client, owners: [privateKeyToAccount(OWNER_KEY)], version: "1.1", nonce: 0n });
}

function freshBuyer(extra?: Record<string, unknown>): AgentClient {
  return new AgentClient({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    escrow: ESCROW_ADDR,
    usdc: USDC_ADDR,
    privateKey: BUYER_KEY,
    ...extra,
  });
}

function sampleOffer(client: AgentClient) {
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

// Minimal executeBatch ABI (mirrors the Coinbase Smart Wallet) so the test can decode callData.
const executeBatchAbi = [
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

describe("smart-account (ERC-4337) funding transport — construction only, no live bundler", () => {
  it("buildFundCalls encodes approve(escrow, price+buyerBond) then fund(offer, sig) to the right targets", () => {
    const buyer = freshBuyer();
    const offer = sampleOffer(buyer);
    const sig: Hex = ("0x" + "ab".repeat(65)) as Hex;
    const calls = buildFundCalls(offer, sig, ESCROW_ADDR, USDC_ADDR);

    expect(calls).toHaveLength(2);

    // call[0] = USDC.approve(escrow, price + buyerBond)
    expect(calls[0]!.to.toLowerCase()).toBe(USDC_ADDR.toLowerCase());
    expect(calls[0]!.value).toBe(0n);
    const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data });
    expect(approve.functionName).toBe("approve");
    expect((approve.args![0] as string).toLowerCase()).toBe(ESCROW_ADDR.toLowerCase());
    expect(approve.args![1]).toBe(BigInt(offer.price) + BigInt(offer.buyerBond));

    // call[1] = Escrow.fund(offerTuple, sellerSig)
    expect(calls[1]!.to.toLowerCase()).toBe(ESCROW_ADDR.toLowerCase());
    const fund = decodeFunctionData({ abi: escrowAbi, data: calls[1]!.data });
    expect(fund.functionName).toBe("fund");
    expect((fund.args![0] as { price: bigint }).price).toBe(BigInt(offer.price));
    expect((fund.args![0] as { nonce: bigint }).nonce).toBe(BigInt(offer.nonce));
    expect(fund.args![1]).toBe(sig);
  });

  it("fundViaSmartAccount builds a correctly-shaped UserOp (sender=smart account, batched callData) without sending", async () => {
    const account = await stubSmartAccount();
    expect(account.address.toLowerCase()).toBe(SENDER_ADDR.toLowerCase());

    const buyer = freshBuyer({ smartAccount: {} }); // opt in, NO bundlerUrl => construction only
    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer); // signature shape is irrelevant to construction

    // STUB bundler: prepareUserOperation returns a well-shaped UserOp using the real encodeCalls; it
    // never touches a network. sendUserOperation is present but must NOT be called (no bundlerUrl).
    const sendSpy = vi.fn(async () => ("0x" + "ff".repeat(32)) as Hex);
    const prepareSpy = vi.fn(async ({ account: a, calls }: { account: SmartAccount; calls: readonly { to: Address; value: bigint; data: Hex }[] }) => ({
      sender: a.address,
      nonce: 7n,
      callData: await a.encodeCalls(calls),
    }));

    const res = await buyer.fundViaSmartAccount(offer, sig, {
      account,
      bundlerClient: { prepareUserOperation: prepareSpy, sendUserOperation: sendSpy },
    });

    // sender is the smart-account address — NOT the buyer EOA.
    expect(res.sender.toLowerCase()).toBe(SENDER_ADDR.toLowerCase());
    expect(res.sender.toLowerCase()).not.toBe(buyer.address.toLowerCase());
    expect(res.userOperation.sender.toLowerCase()).toBe(SENDER_ADDR.toLowerCase());
    expect(res.userOperation.nonce).toBe(7n);

    // NOT sent: no bundlerUrl configured. The send path is gated; construction stops here.
    expect(res.sent).toBe(false);
    expect(res.userOpHash).toBeUndefined();
    expect(sendSpy).not.toHaveBeenCalled();

    // callData decodes to executeBatch with exactly the two funding calls to the right targets.
    const decoded = decodeFunctionData({ abi: executeBatchAbi, data: res.userOperation.callData });
    expect(decoded.functionName).toBe("executeBatch");
    const batched = decoded.args![0] as readonly { target: Address; value: bigint; data: Hex }[];
    expect(batched).toHaveLength(2);
    expect(batched[0]!.target.toLowerCase()).toBe(USDC_ADDR.toLowerCase());
    expect(batched[1]!.target.toLowerCase()).toBe(ESCROW_ADDR.toLowerCase());

    const approve = decodeFunctionData({ abi: erc20Abi, data: batched[0]!.data });
    expect(approve.functionName).toBe("approve");
    expect(approve.args![1]).toBe(BigInt(offer.price) + BigInt(offer.buyerBond));
    const fund = decodeFunctionData({ abi: escrowAbi, data: batched[1]!.data });
    expect(fund.functionName).toBe("fund");
    expect(fund.args![1]).toBe(sig);
  });

  it("dealId equals offerHash(offer) — identical to the EOA path (transport does not affect dealId)", async () => {
    const account = await stubSmartAccount();
    const buyer = freshBuyer({ smartAccount: {} });
    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer);
    const expectedDealId = buyer.offerHash(offer);

    const res = await buyer.fundViaSmartAccount(offer, sig, {
      account,
      bundlerClient: {
        prepareUserOperation: async ({ account, calls }) => ({ sender: account.address, callData: await account.encodeCalls(calls) }),
      },
    });
    expect(res.dealId).toBe(expectedDealId);
  });

  it("paymaster fields are surfaced when the (stub) bundler returns them", async () => {
    const account = await stubSmartAccount();
    const buyer = freshBuyer({ smartAccount: { paymaster: "https://paymaster.example/rpc" } });
    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer);
    const paymaster: Address = "0x4444444444444444444444444444444444444444";
    const paymasterData: Hex = "0xdeadbeef";

    const res = await buyer.fundViaSmartAccount(offer, sig, {
      account,
      bundlerClient: {
        prepareUserOperation: async ({ account, calls }) => ({
          sender: account.address,
          callData: await account.encodeCalls(calls),
          paymaster,
          paymasterData,
          paymasterVerificationGasLimit: 50_000n,
        }),
      },
    });

    expect(res.userOperation.paymaster!.toLowerCase()).toBe(paymaster.toLowerCase());
    expect(res.userOperation.paymasterData).toBe(paymasterData);
    expect(res.userOperation.paymasterVerificationGasLimit).toBe(50_000n);
    expect(res.sent).toBe(false); // still no bundlerUrl -> not sent
  });

  it("SEND path is reached only when a bundlerUrl is configured (still hermetic via stub)", async () => {
    const account = await stubSmartAccount();
    const buyer = freshBuyer({ smartAccount: { bundlerUrl: "https://bundler.example/rpc" } });
    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer);
    const userOpHash = ("0x" + "ab".repeat(32)) as Hex;
    const sendSpy = vi.fn(async () => userOpHash);

    const res = await buyer.fundViaSmartAccount(offer, sig, {
      account,
      bundlerClient: {
        prepareUserOperation: async ({ account, calls }) => ({ sender: account.address, callData: await account.encodeCalls(calls) }),
        sendUserOperation: sendSpy,
      },
    });

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(res.sent).toBe(true);
    expect(res.userOpHash).toBe(userOpHash);
  });
});

describe("EOA path is the DEFAULT — smart-account transport is strictly opt-in", () => {
  it("no smartAccount config => smartAccountEnabled is false and fundViaSmartAccount throws", async () => {
    const buyer = freshBuyer(); // no smartAccount field
    expect(buyer.smartAccountEnabled).toBe(false);

    const offer = sampleOffer(buyer);
    const sig = await buyer.signOffer(offer);
    await expect(buyer.fundViaSmartAccount(offer, sig)).rejects.toThrow(/smart-account transport disabled/);
  });

  it("a smartAccount config flips smartAccountEnabled on without altering offer/dealId derivation", async () => {
    const eoa = freshBuyer();
    const sa = freshBuyer({ smartAccount: {} });
    expect(eoa.smartAccountEnabled).toBe(false);
    expect(sa.smartAccountEnabled).toBe(true);

    // offerHash is config-derived (chainId + escrow) and identical regardless of transport config.
    const offer = sampleOffer(eoa);
    expect(sa.offerHash(offer)).toBe(eoa.offerHash(offer));
  });
});
