/// HERMETIC unit tests for the SDK SubscriptionEscrow support (Tier 3 "rent"). NOTHING here contacts a
/// live chain — every check is pure crypto (EIP-712 hashing/signing) or static ABI/shape assertions,
/// mirroring the x402 / offerHash discipline of remediations.test.ts.
///
///   1. subOfferHash STABILITY + PARITY: subOfferHash(offer) == subId == the EIP-712 digest the
///      contract derives in start(), with ZERO drift. We reconstruct the digest from FIRST PRINCIPLES
///      (the literal SUB_OFFER_TYPEHASH string + the EIP712("ObulusSubscription","1") domain separator +
///      a hand-encoded structHash) and assert it equals subOfferHash — so a field-order/type mistake in
///      SUB_OFFER_TYPE or subOfferToTuple is caught against the contract's authoritative typehash.
///   2. SubscriptionEscrow ABI shape: the start/lifecycle/getter surface + the SubOffer tuple component
///      order/types match the contract (and SUB_OFFER_TYPE).
///   3. The OPT-IN flag: absent subscriptionEscrow => every subscription method throws "subscriptions
///      disabled" (subscriptions stay DISABLED by default).
///   4. Signature recovery: signSubOffer → verifySubOfferSignature recovers to the seller; a foreign
///      signer / tampered field does not.

import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  toHex,
  hashTypedData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentClient } from "../src/client.js";
import { subscriptionEscrowAbi } from "../src/abi.js";
import { SUB_OFFER_TYPE, subOfferToTuple, type SubOfferJson } from "../src/types.js";

// ── fixtures ────────────────────────────────────────────────────────────────────
const CHAIN_ID = 46630; // Robinhood Chain testnet
const RPC = "http://127.0.0.1:0/never-dialed";
const ESCROW_ADDR: Address = "0x1111111111111111111111111111111111111111";
const USDC_ADDR: Address = "0x2222222222222222222222222222222222222222";
const SUB_ESCROW_ADDR: Address = "0x4444444444444444444444444444444444444444";
const ARBITER: Address = "0x3333333333333333333333333333333333333333";
const SELLER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OTHER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/// The AUTHORITATIVE typehash string copied verbatim from SubscriptionEscrow.sol's SUB_OFFER_TYPEHASH.
/// If SUB_OFFER_TYPE / subOfferToTuple drift from this, the parity test below fails.
const SUB_OFFER_TYPEHASH_STRING =
  "SubOffer(address seller,address subscriber,address arbiter,address token,uint256 periodPrice,uint256 sellerBond,uint256 subscriberBond,uint32 numPeriods,uint64 periodLength,uint64 challengeWindow,uint64 startAt,uint16 feeBps,bytes32 specHash,uint256 nonce,uint64 sigDeadline)";

function subClient(opts?: { withSub?: boolean }): AgentClient {
  return new AgentClient({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    escrow: ESCROW_ADDR,
    usdc: USDC_ADDR,
    privateKey: SELLER_KEY,
    ...(opts?.withSub === false ? {} : { subscriptionEscrow: SUB_ESCROW_ADDR }),
  });
}

function sampleSubOffer(client: AgentClient): SubOfferJson {
  return client.buildSubOffer({
    arbiter: ARBITER,
    periodPriceUsd: 5,
    sellerBondUsd: 12,
    subscriberBondUsd: 8,
    numPeriods: 6,
    periodLengthS: 86_400,
    challengeWindowS: 3_600,
    startAt: 1_900_000_000,
    feeBps: 100,
    spec: "weekly data feed",
  });
}

/// Reconstruct the EIP-712 digest from FIRST PRINCIPLES — the literal contract typehash + the
/// EIP712("ObulusSubscription","1") domain separator + a hand-encoded structHash. This is the
/// contract's authoritative computation, independent of SUB_OFFER_TYPE, so it pins the SDK's hash to
/// the contract's. Returns the 32-byte digest (== subId).
function digestFromFirstPrinciples(o: SubOfferJson): Hex {
  const typeHash = keccak256(toHex(SUB_OFFER_TYPEHASH_STRING));
  const t = subOfferToTuple(o);
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, // SUB_OFFER_TYPEHASH
        { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
        { type: "uint16" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" },
      ],
      [
        typeHash,
        t.seller, t.subscriber, t.arbiter, t.token,
        t.periodPrice, t.sellerBond, t.subscriberBond,
        t.numPeriods, t.periodLength, t.challengeWindow, t.startAt,
        t.feeBps, t.specHash, t.nonce, t.sigDeadline,
      ],
    ),
  );
  // EIP-712 domain separator for EIP712("ObulusSubscription","1") at (chainId, verifyingContract).
  const domainTypeHash = keccak256(
    toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        domainTypeHash,
        keccak256(toHex("ObulusSubscription")),
        keccak256(toHex("1")),
        BigInt(CHAIN_ID),
        SUB_ESCROW_ADDR,
      ],
    ),
  );
  // \x19\x01 ‖ domainSeparator ‖ structHash
  return keccak256(("0x1901" + domainSeparator.slice(2) + structHash.slice(2)) as Hex);
}

// ── 1. subOfferHash stability + parity (subId == EIP-712 digest, zero drift) ──────────────────────
describe("subscription — subOfferHash stability + parity (subId == EIP-712 digest, zero drift)", () => {
  it("subOfferHash equals the digest reconstructed from the contract's literal SUB_OFFER_TYPEHASH + domain", () => {
    const client = subClient();
    const offer = sampleSubOffer(client);
    // The SDK's subOfferHash MUST equal the contract's authoritative first-principles digest.
    expect(client.subOfferHash(offer)).toBe(digestFromFirstPrinciples(offer));
  });

  it("subOfferHash equals viem's hashTypedData under the SubscriptionEscrow domain (SUB_OFFER_TYPE parity)", () => {
    const client = subClient();
    const offer = sampleSubOffer(client);
    const viemDigest = hashTypedData({
      domain: { name: "ObulusSubscription", version: "1", chainId: CHAIN_ID, verifyingContract: SUB_ESCROW_ADDR },
      types: SUB_OFFER_TYPE,
      primaryType: "SubOffer",
      message: subOfferToTuple(offer) as never,
    });
    expect(client.subOfferHash(offer)).toBe(viemDigest);
  });

  it("is STABLE: the same offer always hashes to the same subId", () => {
    const client = subClient();
    const offer = sampleSubOffer(client);
    expect(client.subOfferHash(offer)).toBe(client.subOfferHash(offer));
  });

  it("any field change (nonce, periodPrice, numPeriods) changes the subId", () => {
    const client = subClient();
    const offer = sampleSubOffer(client);
    const base = client.subOfferHash(offer);
    expect(client.subOfferHash({ ...offer, nonce: offer.nonce + "1" })).not.toBe(base);
    expect(client.subOfferHash({ ...offer, periodPrice: "1" })).not.toBe(base);
    expect(client.subOfferHash({ ...offer, numPeriods: offer.numPeriods + 1 })).not.toBe(base);
  });

  it("is domain-separated from the single Escrow: the same logical terms hash differently under each domain", () => {
    const client = subClient();
    const offer = sampleSubOffer(client);
    // Same structHash bytes, different domain name => different digest. Re-derive under "Obulus"
    // and confirm it does NOT collide with the subscription digest (no cross-domain replay).
    const subDigest = client.subOfferHash(offer);
    const wrongDomainDigest = hashTypedData({
      domain: { name: "Obulus", version: "1", chainId: CHAIN_ID, verifyingContract: SUB_ESCROW_ADDR },
      types: SUB_OFFER_TYPE,
      primaryType: "SubOffer",
      message: subOfferToTuple(offer) as never,
    });
    expect(wrongDomainDigest).not.toBe(subDigest);
  });
});

// ── 2. SubscriptionEscrow ABI shape ───────────────────────────────────────────────────────────────
describe("subscription — SubscriptionEscrow ABI shape matches the contract", () => {
  const byName = (n: string) => subscriptionEscrowAbi.find((e) => (e as { name?: string }).name === n);

  it("exposes the full lifecycle + getter surface", () => {
    for (const fn of [
      "start", "activate", "claimPeriod", "disputePeriod", "resolvePeriod", "resolvePeriodExpired",
      "revoke", "expireSub", "close", "withdraw", "cancelOffer",
      "credits", "getSub", "hashSubOffer", "pendingDisputes", "periodDisputedAt",
    ]) {
      expect(byName(fn), `missing ABI fn ${fn}`).toBeDefined();
    }
  });

  it("start(offer, sellerSig) returns subId and takes the SubOffer tuple", () => {
    const start = byName("start") as { inputs: readonly { name: string; type: string }[]; outputs: readonly { name?: string; type: string }[] };
    expect(start.inputs[0]!.type).toBe("tuple");
    expect(start.inputs[1]!).toMatchObject({ name: "sellerSig", type: "bytes" });
    expect(start.outputs[0]!.type).toBe("bytes32"); // subId
  });

  it("the SubOffer tuple components match SUB_OFFER_TYPE field-for-field (order + type)", () => {
    const start = byName("start") as { inputs: readonly { type: string; components?: readonly { name: string; type: string }[] }[] };
    const components = start.inputs[0]!.components!;
    expect(components.map((c) => c.name)).toStrictEqual(SUB_OFFER_TYPE.SubOffer.map((f) => f.name));
    expect(components.map((c) => c.type)).toStrictEqual(SUB_OFFER_TYPE.SubOffer.map((f) => f.type));
  });

  it("resolvePeriod takes (subId, period:uint32, sellerBps:uint16)", () => {
    const r = byName("resolvePeriod") as { inputs: readonly { name: string; type: string }[] };
    expect(r.inputs.map((i) => i.type)).toStrictEqual(["bytes32", "uint32", "uint16"]);
  });

  it("getSub returns the Sub tuple whose first fields are the parties + the per-period accounting", () => {
    const getSub = byName("getSub") as { outputs: readonly { type: string; components?: readonly { name: string; type: string }[] }[] };
    const comps = getSub.outputs[0]!.components!;
    expect(comps.slice(0, 3).map((c) => c.name)).toStrictEqual(["subscriber", "seller", "arbiter"]);
    expect(comps.find((c) => c.name === "escrowedPrice")!.type).toBe("uint256");
    expect(comps.find((c) => c.name === "state")!.type).toBe("uint8");
  });
});

// ── 3. OPT-IN flag: subscriptions DISABLED unless an address is configured ─────────────────────────
describe("subscription — OPT-IN: absent subscriptionEscrow disables every subscription method", () => {
  it("subscriptionsEnabled reflects the config flag", () => {
    expect(subClient({ withSub: false }).subscriptionsEnabled).toBe(false);
    expect(subClient().subscriptionsEnabled).toBe(true);
  });

  it("signSubOffer / subOfferHash-dependent paths throw a clear 'subscriptions disabled' error", async () => {
    const client = subClient({ withSub: false });
    // buildSubOffer needs no escrow address (pure), but signSubOffer + all writes/reads must throw.
    const offer = client.buildSubOffer({
      arbiter: ARBITER, periodPriceUsd: 5, sellerBondUsd: 12, subscriberBondUsd: 8,
      numPeriods: 6, periodLengthS: 86_400, challengeWindowS: 3_600, feeBps: 100, spec: "x",
    });
    await expect(client.signSubOffer(offer)).rejects.toThrow(/subscriptions disabled/i);
    const subId = ("0x" + "ab".repeat(32)) as Hex;
    await expect(client.claimPeriod(subId)).rejects.toThrow(/subscriptions disabled/i);
    await expect(client.revokeSubscription(subId)).rejects.toThrow(/subscriptions disabled/i);
    await expect(client.closeSubscription(subId)).rejects.toThrow(/subscriptions disabled/i);
    await expect(client.withdrawSubscription()).rejects.toThrow(/subscriptions disabled/i);
    await expect(client.getSub(subId)).rejects.toThrow(/subscriptions disabled/i);
    await expect(client.subStatus(subId)).rejects.toThrow(/subscriptions disabled/i);
  });
});

// ── 4. signSubOffer recovers to the seller under the subscription domain ───────────────────────────
describe("subscription — signSubOffer / verifySubOfferSignature", () => {
  it("a seller-signed SubOffer recovers to offer.seller; a foreign signer / tampered field does not", async () => {
    const client = subClient();
    const offer = sampleSubOffer(client);
    const sig = await client.signSubOffer(offer);

    // The seller's signature recovers under THIS subscription domain (the exact check start() makes).
    expect(await client.verifySubOfferSignature(offer, sig)).toBe(true);

    // A tampered field (periodPrice) breaks recovery.
    expect(await client.verifySubOfferSignature({ ...offer, periodPrice: "1" }, sig)).toBe(false);

    // A signature from a DIFFERENT signer for an offer that still names `client` as seller fails.
    const other = privateKeyToAccount(OTHER_KEY);
    const foreignSig = await other.signTypedData({
      domain: { name: "ObulusSubscription", version: "1", chainId: CHAIN_ID, verifyingContract: SUB_ESCROW_ADDR },
      types: SUB_OFFER_TYPE,
      primaryType: "SubOffer",
      message: subOfferToTuple(offer) as never,
    });
    expect(await client.verifySubOfferSignature(offer, foreignSig)).toBe(false);

    // Garbage signature → false (not a throw).
    expect(await client.verifySubOfferSignature(offer, ("0x" + "00".repeat(65)) as Hex)).toBe(false);
  });

  it("buildSubOffer stamps the seller as this client and usd6-scales the money fields", () => {
    const client = subClient();
    const offer = sampleSubOffer(client);
    expect(offer.seller.toLowerCase()).toBe(privateKeyToAccount(SELLER_KEY).address.toLowerCase());
    expect(offer.periodPrice).toBe("5000000"); // 5 USDC base-6
    expect(offer.sellerBond).toBe("12000000");
    expect(offer.subscriberBond).toBe("8000000");
    expect(offer.token.toLowerCase()).toBe(USDC_ADDR.toLowerCase());
    expect(offer.numPeriods).toBe(6);
  });
});
