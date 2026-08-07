/// Minimal vendored ABIs (mirror of contracts/src/Escrow.sol) so the SDK never reads artifact files.
const offerComponents = [
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
] as const;

const dealComponents = [
  { name: "buyer", type: "address" },
  { name: "feeBps", type: "uint16" },
  { name: "state", type: "uint8" },
  { name: "seller", type: "address" },
  { name: "arbiter", type: "address" },
  { name: "price", type: "uint256" },
  { name: "buyerBond", type: "uint256" },
  { name: "sellerBond", type: "uint256" },
  { name: "deliverDeadline", type: "uint64" },
  { name: "confirmWindow", type: "uint64" },
  { name: "deliveredAt", type: "uint64" },
  { name: "disputedAt", type: "uint64" },
  { name: "deliveryHash", type: "bytes32" },
] as const;

export const escrowAbi = [
  { type: "function", name: "fund", stateMutability: "nonpayable", inputs: [{ name: "offer", type: "tuple", components: offerComponents }, { name: "sellerSig", type: "bytes" }], outputs: [{ name: "dealId", type: "bytes32" }] },
  { type: "function", name: "markDelivered", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }, { name: "deliveryHash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "confirm", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "claimTimeout", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "refundExpired", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "resolveExpired", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "dispute", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "resolve", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }, { name: "sellerBps", type: "uint16" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "credits", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getDeal", stateMutability: "view", inputs: [{ name: "dealId", type: "bytes32" }], outputs: [{ name: "deal", type: "tuple", components: dealComponents }] },
  { type: "function", name: "hashOffer", stateMutability: "view", inputs: [{ name: "offer", type: "tuple", components: offerComponents }], outputs: [{ type: "bytes32" }] },
] as const;

// SubscriptionEscrow (Tier 3 "rent") — mirror of contracts/src/SubscriptionEscrow.sol. The SubOffer
// tuple field order/types match SUB_OFFER_TYPEHASH exactly; the Sub tuple matches the storage struct
// field order (so getSub decodes positionally). Vendored so the SDK never reads artifact files.
const subOfferComponents = [
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
] as const;

const subComponents = [
  { name: "subscriber", type: "address" },
  { name: "seller", type: "address" },
  { name: "arbiter", type: "address" },
  { name: "periodPrice", type: "uint256" },
  { name: "sellerBond", type: "uint256" },
  { name: "subscriberBond", type: "uint256" },
  { name: "escrowedPrice", type: "uint256" },
  { name: "sellerBondRem", type: "uint256" },
  { name: "subscriberBondRem", type: "uint256" },
  { name: "depositHeld", type: "uint256" },
  { name: "numPeriods", type: "uint32" },
  { name: "cursor", type: "uint32" },
  { name: "settledCount", type: "uint32" },
  { name: "periodLength", type: "uint64" },
  { name: "challengeWindow", type: "uint64" },
  { name: "startAt", type: "uint64" },
  { name: "activatedAt", type: "uint64" },
  { name: "feeBps", type: "uint16" },
  { name: "activated", type: "bool" },
  { name: "state", type: "uint8" },
] as const;

export const subscriptionEscrowAbi = [
  { type: "function", name: "start", stateMutability: "nonpayable", inputs: [{ name: "offer", type: "tuple", components: subOfferComponents }, { name: "sellerSig", type: "bytes" }], outputs: [{ name: "subId", type: "bytes32" }] },
  { type: "function", name: "activate", stateMutability: "nonpayable", inputs: [{ name: "subId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "claimPeriod", stateMutability: "nonpayable", inputs: [{ name: "subId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "disputePeriod", stateMutability: "nonpayable", inputs: [{ name: "subId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "resolvePeriod", stateMutability: "nonpayable", inputs: [{ name: "subId", type: "bytes32" }, { name: "period", type: "uint32" }, { name: "sellerBps", type: "uint16" }], outputs: [] },
  { type: "function", name: "resolvePeriodExpired", stateMutability: "nonpayable", inputs: [{ name: "subId", type: "bytes32" }, { name: "period", type: "uint32" }], outputs: [] },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ name: "subId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "expireSub", stateMutability: "nonpayable", inputs: [{ name: "subId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "close", stateMutability: "nonpayable", inputs: [{ name: "subId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "cancelOffer", stateMutability: "nonpayable", inputs: [{ name: "nonce", type: "uint256" }], outputs: [] },
  { type: "function", name: "credits", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getSub", stateMutability: "view", inputs: [{ name: "subId", type: "bytes32" }], outputs: [{ name: "sub", type: "tuple", components: subComponents }] },
  { type: "function", name: "hashSubOffer", stateMutability: "view", inputs: [{ name: "offer", type: "tuple", components: subOfferComponents }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "pendingDisputes", stateMutability: "view", inputs: [{ name: "subId", type: "bytes32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "periodDisputedAt", stateMutability: "view", inputs: [{ name: "subId", type: "bytes32" }, { name: "period", type: "uint32" }], outputs: [{ type: "uint64" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/// Minimal vendored StakingVault ABI (mirror of contracts/src/StakingVault.sol) — the stake/unstake/
/// withdraw/read surface the SDK drives. The slash() path is arbiter-only and lives on-chain; the SDK
/// agent never calls it, so it is intentionally omitted here (read pendingWithdrawal/stakeOf instead).
export const stakingVaultAbi = [
  { type: "function", name: "stake", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "unstake", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "stakeOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingWithdrawal", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "amount", type: "uint256" }, { name: "unlockAt", type: "uint64" }] },
  { type: "function", name: "totalStaked", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/// Minimal vendored YieldVault ABI (mirror of contracts/src/YieldVault.sol) — the deposit/withdraw/redeem/
/// read surface the SDK drives for an agent's OPT-IN surplus vault. The admin surface (setYieldSource/
/// pause/setWithdrawFeeBps/setTreasury) is owner-only and never called by an agent, so it is omitted.
/// The vault is a NEW standalone contract that NEVER touches escrow principal or bonds — it only ever
/// holds funds a depositor voluntarily deposited as surplus. `deposit`/`redeem`/`withdraw` mint/burn
/// share-accounted balances; reads value those shares against the vault's honest `totalAssets()`.
export const yieldVaultAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ name: "shares", type: "uint256" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }, { name: "minAssetsOut", type: "uint256" }], outputs: [{ name: "netAssets", type: "uint256" }] },
  { type: "function", name: "redeem", stateMutability: "nonpayable", inputs: [{ name: "shares", type: "uint256" }, { name: "receiver", type: "address" }, { name: "minAssetsOut", type: "uint256" }], outputs: [{ name: "netAssets", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "convertToShares", stateMutability: "view", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "previewRedeem", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "previewDeposit", stateMutability: "view", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxWithdraw", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalShares", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
