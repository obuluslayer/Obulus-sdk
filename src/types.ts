export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/// Canonical JSON shape of a signed offer (uint values as decimal strings, USDC base-6).
/// Mirrors the Hub protocol and the contract's Offer struct field-for-field.
export interface OfferJson {
  seller: Address;
  buyer: Address; // zero address = open offer
  arbiter: Address;
  token: Address;
  price: string;
  buyerBond: string;
  sellerBond: string;
  deliverDeadline: string; // unix seconds
  confirmWindow: string; // seconds
  feeBps: number;
  specHash: Hex;
  nonce: string;
  sigDeadline: string; // unix seconds
}

/// EIP-712 Offer type — MUST match Escrow.sol's OFFER_TYPEHASH (13 fields, exact order/types).
export const OFFER_TYPE = {
  Offer: [
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "arbiter", type: "address" },
    { name: "token", type: "address" },
    { name: "price", type: "uint256" },
    { name: "buyerBond", type: "uint256" },
    { name: "sellerBond", type: "uint256" },
    { name: "deliverDeadline", type: "uint64" },
    { name: "confirmWindow", type: "uint64" },
    { name: "feeBps", type: "uint16" },
    { name: "specHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "sigDeadline", type: "uint64" },
  ],
} as const;

/// The CANONICAL Offer tuple as viem expects it for EIP-712 hashing/signing AND for the contract's
/// `fund(Offer, sig)` calldata: uint fields widened from decimal strings to bigint, addresses/bytes32
/// kept as-is. This is the SINGLE encoder — both the EOA fund() path (AgentClient) and the ERC-4337
/// buildFundCalls path import it, so an Offer-struct change can never silently diverge the two (and
/// thus never diverge the dealId == offerHash between the EOA and 4337 transports). Field order/types
/// mirror OFFER_TYPE / Escrow.sol's Offer struct exactly.
export function offerToTuple(o: OfferJson) {
  return {
    seller: o.seller,
    buyer: o.buyer,
    arbiter: o.arbiter,
    token: o.token,
    price: BigInt(o.price),
    buyerBond: BigInt(o.buyerBond),
    sellerBond: BigInt(o.sellerBond),
    deliverDeadline: BigInt(o.deliverDeadline),
    confirmWindow: BigInt(o.confirmWindow),
    feeBps: o.feeBps,
    specHash: o.specHash,
    nonce: BigInt(o.nonce),
    sigDeadline: BigInt(o.sigDeadline),
  };
}

export const DEAL_STATES = ["None", "Funded", "Delivered", "Disputed", "Resolved"] as const;
export type DealState = (typeof DEAL_STATES)[number];

// --- SubscriptionEscrow (Tier 3 "rent") --------------------------------------------------------
// Sibling of the single Escrow path: the subscriber prepays N periods (escrowedPrice =
// numPeriods*periodPrice) + a subscriberBond; the seller posts a sellerBond at activate. The
// contract HOLDS it. Per period the seller claimPeriod after a challenge window (optimistic release)
// → periodPrice (minus feeBps) credits the seller. The subscriber disputePeriod (per-period, cursor
// set-aside) → arbiter resolvePeriod splits. revoke refunds the UNCONSUMED periods to the subscriber.
// KEY money flow: rent for DELIVERED periods goes to the SELLER; the buyer only gets back unconsumed
// periods + its bond. Mirrors the single-Escrow OfferJson discipline (uints as decimal strings).

/// Canonical JSON shape of a signed subscription offer (uint values as decimal strings, USDC base-6).
/// Mirrors SubscriptionEscrow.sol's SubOffer struct field-for-field (15 fields, exact order/types).
export interface SubOfferJson {
  seller: Address;
  subscriber: Address; // zero address = open: the funder becomes the subscriber
  arbiter: Address;
  token: Address;
  periodPrice: string;
  sellerBond: string;
  subscriberBond: string;
  numPeriods: number; // uint32
  periodLength: string; // seconds (uint64)
  challengeWindow: string; // seconds (uint64)
  startAt: string; // unix seconds (uint64)
  feeBps: number;
  specHash: Hex;
  nonce: string;
  sigDeadline: string; // unix seconds (uint64)
}

/// EIP-712 SubOffer type — MUST match SubscriptionEscrow.sol's SUB_OFFER_TYPEHASH (15 fields, exact
/// order/types). Verified field-for-field against the contract's keccak256 string.
export const SUB_OFFER_TYPE = {
  SubOffer: [
    { name: "seller", type: "address" },
    { name: "subscriber", type: "address" },
    { name: "arbiter", type: "address" },
    { name: "token", type: "address" },
    { name: "periodPrice", type: "uint256" },
    { name: "sellerBond", type: "uint256" },
    { name: "subscriberBond", type: "uint256" },
    { name: "numPeriods", type: "uint32" },
    { name: "periodLength", type: "uint64" },
    { name: "challengeWindow", type: "uint64" },
    { name: "startAt", type: "uint64" },
    { name: "feeBps", type: "uint16" },
    { name: "specHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "sigDeadline", type: "uint64" },
  ],
} as const;

/// The CANONICAL SubOffer tuple as viem expects it for EIP-712 hashing/signing AND for the contract's
/// `start(SubOffer, sig)` calldata: uint fields widened from decimal strings to bigint, addresses/
/// bytes32 kept as-is. The SINGLE encoder — both signSubOffer and startSubscription import it, so a
/// SubOffer-struct change can never silently diverge the signing digest from the start() calldata (and
/// thus never diverge subId == subOfferHash). Field order/types mirror SUB_OFFER_TYPE / the contract.
export function subOfferToTuple(o: SubOfferJson) {
  return {
    seller: o.seller,
    subscriber: o.subscriber,
    arbiter: o.arbiter,
    token: o.token,
    periodPrice: BigInt(o.periodPrice),
    sellerBond: BigInt(o.sellerBond),
    subscriberBond: BigInt(o.subscriberBond),
    numPeriods: o.numPeriods,
    periodLength: BigInt(o.periodLength),
    challengeWindow: BigInt(o.challengeWindow),
    startAt: BigInt(o.startAt),
    feeBps: o.feeBps,
    specHash: o.specHash,
    nonce: BigInt(o.nonce),
    sigDeadline: BigInt(o.sigDeadline),
  };
}

export const SUB_STATES = ["None", "Active", "Closed"] as const;
export type SubState = (typeof SUB_STATES)[number];

/// Decoded SubscriptionEscrow.getSub() struct (the Sub storage view).
export interface OnchainSub {
  subscriber: Address;
  seller: Address;
  arbiter: Address;
  periodPrice: bigint;
  sellerBond: bigint;
  subscriberBond: bigint;
  escrowedPrice: bigint;
  sellerBondRem: bigint;
  subscriberBondRem: bigint;
  depositHeld: bigint;
  numPeriods: number;
  cursor: number;
  settledCount: number;
  periodLength: bigint;
  challengeWindow: bigint;
  startAt: bigint;
  activatedAt: bigint;
  feeBps: number;
  activated: boolean;
  state: number; // index into SUB_STATES
}

/// One x402 payment requirement ("exact" scheme over USDC). Mirrors the Hub's X402AcceptSchema.
export interface X402Accept {
  scheme: "exact";
  network: string; // "robinhood-testnet" | "robinhood" | a chainId string
  maxAmountRequired: string; // price in USDC base-6
  asset: Address; // USDC token address
  payTo: Address; // Escrow contract address
  resource: string;
  description: string;
}

/// The HTTP 402 "Payment Required" quote envelope. `offer` + `signature` are sufficient to fund;
/// `signature` is empty ("0x" or "") for a TERMS-only (unsigned) on-chain quote. Mirrors the Hub.
export interface X402Quote {
  x402Version: 1;
  accepts: X402Accept[];
  offer: OfferJson; // the seller-signed Offer (all 13 fields) — dealId == offerHash(offer)
  signature: Hex | "";
  chainId: number;
  escrow: Address;
}

/// What a buyer POSTs to a seller's /x402/quote endpoint to request a priced quote for a job.
export interface X402QuoteRequest {
  spec?: string; // free-form job description (keccak256'd into specHash)
  specHash?: Hex; // OR a precomputed bytes32 spec hash
  buyer?: Address; // omit → an open offer
  priceUsdc?: string; // base-6; the seller may clamp/override
  resource?: string;
}

// --- runtime validation (zod-free; the SDK depends on viem only) --------------------------------
// Mirror of the Hub's X402QuoteSchema (backend/src/protocol/messages.ts). The buyer consumes an
// UNTRUSTED seller endpoint, so a structurally malformed 402 body must fail early with a clear
// error BEFORE any term/signature/economic checks (assertQuoteTerms) or an on-chain fund tx.

const RE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RE_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const RE_UINT = /^\d+$/; // decimal string (USDC base-6 amounts, deadlines, nonce)
const RE_HEX = /^0x[0-9a-fA-F]*$/; // signature: hex, possibly empty ("0x"/"" = TERMS-only)
const MAX_U256 = 2n ** 256n - 1n;
const MAX_U64 = 2n ** 64n - 1n;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function assertStr(v: unknown, re: RegExp, where: string): void {
  if (typeof v !== "string" || !re.test(v)) throw new Error(`x402: malformed quote — ${where}`);
}
function assertUintBound(v: unknown, max: bigint, where: string): void {
  assertStr(v, RE_UINT, where);
  if (BigInt(v as string) > max) throw new Error(`x402: malformed quote — ${where} out of range`);
}

/// Validate the seller's 402 JSON against the X402Quote shape and return it typed. Throws a clear
/// `x402: malformed quote — …` Error on any structural violation (mirrors X402QuoteSchema).
export function validateX402Quote(v: unknown): X402Quote {
  if (!isObj(v)) throw new Error("x402: malformed quote — not an object");
  if (v.x402Version !== 1) throw new Error("x402: malformed quote — x402Version must be 1");
  if (!Array.isArray(v.accepts) || v.accepts.length < 1) throw new Error("x402: malformed quote — accepts must be a non-empty array");
  for (const a of v.accepts) {
    if (!isObj(a)) throw new Error("x402: malformed quote — accepts[] entry not an object");
    if (a.scheme !== "exact") throw new Error('x402: malformed quote — accepts.scheme must be "exact"');
    if (typeof a.network !== "string" || a.network.length < 1) throw new Error("x402: malformed quote — accepts.network");
    assertUintBound(a.maxAmountRequired, MAX_U256, "accepts.maxAmountRequired");
    assertStr(a.asset, RE_ADDRESS, "accepts.asset");
    assertStr(a.payTo, RE_ADDRESS, "accepts.payTo");
    if (typeof a.resource !== "string" || a.resource.length < 1 || a.resource.length > 1024) throw new Error("x402: malformed quote — accepts.resource");
    if (a.description !== undefined && typeof a.description !== "string") throw new Error("x402: malformed quote — accepts.description");
  }
  if (typeof v.signature !== "string" || !RE_HEX.test(v.signature)) throw new Error("x402: malformed quote — signature must be hex");
  if (typeof v.chainId !== "number" || !Number.isInteger(v.chainId) || v.chainId <= 0) throw new Error("x402: malformed quote — chainId");
  assertStr(v.escrow, RE_ADDRESS, "escrow");
  validateOfferJson(v.offer);
  return v as unknown as X402Quote;
}

function validateOfferJson(o: unknown): void {
  if (!isObj(o)) throw new Error("x402: malformed quote — offer not an object");
  for (const f of ["seller", "buyer", "arbiter", "token"] as const) assertStr(o[f], RE_ADDRESS, `offer.${f}`);
  for (const f of ["price", "buyerBond", "sellerBond", "nonce"] as const) assertUintBound(o[f], MAX_U256, `offer.${f}`);
  for (const f of ["deliverDeadline", "confirmWindow", "sigDeadline"] as const) assertUintBound(o[f], MAX_U64, `offer.${f}`);
  assertStr(o.specHash, RE_BYTES32, "offer.specHash");
  if (typeof o.feeBps !== "number" || !Number.isInteger(o.feeBps) || o.feeBps < 0 || o.feeBps > 0xffff) throw new Error("x402: malformed quote — offer.feeBps");
}

/// Decoded Escrow.getDeal() struct.
export interface OnchainDeal {
  buyer: Address;
  feeBps: number;
  state: number; // index into DEAL_STATES
  seller: Address;
  arbiter: Address;
  price: bigint;
  buyerBond: bigint;
  sellerBond: bigint;
  deliverDeadline: bigint;
  confirmWindow: bigint;
  deliveredAt: bigint;
  disputedAt: bigint;
  deliveryHash: Hex;
}

export interface TxReceiptInfo {
  txHash: Hex;
  blockNumber: bigint;
}
