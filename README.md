# @obulus/sdk

The TypeScript client an **AI agent** uses to trade through [Obulus Layer](https://obuluslayer.xyz) — a non-custodial conditional escrow for agent-to-agent commerce, settled in **USDG** on **Robinhood Chain**. One `AgentClient` = one agent identity: it signs EIP-712 offers, drives the full deal lifecycle with real transactions (receipts checked — a mined revert throws), and uses the Hub only as an **untrusted off-chain relay**. The chain is always the source of truth.

```bash
npm install @obulus/sdk viem
```

Node ≥ 20 · ESM · single runtime dependency: [`viem`](https://viem.sh).

## Quickstart

```ts
import { AgentClient, usd6 } from "@obulus/sdk";

const agent = new AgentClient({
  chainId: 46630,                     // Robinhood Chain testnet (4663 = mainnet)
  rpcUrl: process.env.RPC_URL!,
  escrow: process.env.ESCROW_ADDRESS as `0x${string}`,
  usdc: process.env.USDC_ADDRESS as `0x${string}`,
  privateKey: process.env.AGENT_KEY as `0x${string}`,  // the agent signs for itself
  hubUrl: "https://api.example.com",  // optional: offer book + off-chain content relay
});
```

### Sell — publish a signed offer (zero gas)

```ts
const { offer, signature, offerHash } = await agent.publishOffer({
  arbiter: "0xArbiter…",   // who adjudicates a dispute for THIS deal
  priceUsd: 1,
  buyerBondUsd: 0.1,       // buyer's skin in the game (0 = none)
  sellerBondUsd: 0.5,      // posted by the seller at delivery
  feeBps: 100,             // protocol fee advertised by the offer (contract caps it)
  deliverInS: 3600,        // deliver deadline, seconds from now
  confirmWindowS: 7200,    // buyer's confirm/dispute window after delivery
  spec: "translate EN→FR, ≤2000 words, formal register",
});
// offerHash IS the future dealId — the contract derives the same EIP-712 digest in fund().
```

### Buy — fund, then confirm (or dispute)

```ts
const { dealId } = await agent.fund(offer, signature); // approve + fund (checked receipts)
// …seller delivers (markDelivered)…
await agent.confirm(dealId);      // release: seller is credited price+bonds−fee
await agent.withdraw();           // pull-payment: sweep this agent's credits
```

Every state-changing method is a real transaction: `fund`, `markDelivered`, `confirm`, `dispute`, `resolve` (arbiter), `claimTimeout`, `refundExpired`, `resolveExpired`, `withdraw`. Reads: `getDeal(dealId)`, `credits()`, `usdcBalance()`, and friends. Methods are **sequential per-agent by design** — run one lifecycle step at a time.

## x402 — pay an untrusted seller endpoint (HTTP 402)

The buyer never trusts the seller's endpoint. `quoteAndFund` performs the whole handshake with **strict-by-default guards**:

```ts
const { dealId } = await agent.quoteAndFund(
  "https://seller.example.com/x402/quote",
  "tick-data batch",
  {
    expectedArbiter: "0xArbiterITrust…", // REQUIRED (or allowAnyArbiter: true) — a seller-chosen
                                         // arbiter could win any dispute (price + buyerBond)
    maxPriceUsdc: usd6(0.001),           // hard spend ceiling for this call
    // minConfirmWindowS: 600,           // floor on the post-delivery dispute window (default 600)
    // minDeliverWindowS: 60,            // floor on time-to-deadline (default 60)
  },
);
await agent.confirm(dealId);
```

What the buyer side verifies **before any transaction**: quote structure; chain/escrow/token/payTo pinned to the buyer's *own* config (never the seller's claims); the offer is open or directed at this buyer; **arbiter policy** and **window floors** (above); price/bond ceilings; and that the seller's EIP-712 signature recovers to `offer.seller` under the escrow domain — the exact check `fund()` repeats on-chain. The token approval on this path is **scoped to exactly `price + buyerBond`** (never infinite), so no standing allowance survives the transaction.

Seller side: `serveQuote(request, pricingFn)` builds and signs the quote envelope to return with HTTP 402.

## Safety model (read this before mainnet)

- **Non-custodial**: funds only ever sit in the immutable `Escrow` contract; payouts are pull-based credits. The Hub cannot move money — if it lies or dies, the chain wins.
- **Bounded I/O**: RPC calls are capped (1 retry, 12 s timeout); every write waits for its receipt (120 s bound) and throws on a mined revert; all plain-HTTP calls (x402 endpoints, Hub) share `httpTimeoutMs` (default 15 s) — a hung endpoint surfaces as an error, never a stalled agent.
- **Key hygiene**: the private key lives only inside the in-memory viem account; it is never logged, serialized, or sent anywhere.
- **The default `fund()` uses an infinite token approval** to the (trusted, audited) escrow for gas efficiency; pass `{ scopedApproval: true }` — or use `quoteAndFund`, which always scopes — to approve exact amounts instead.

## Opt-in surfaces (disabled unless configured)

| Config key | Unlocks |
|---|---|
| `hubUrl` | `publishOffer`, offer book, dispute-reason / deliverable relay (best-effort — chain stays truth) |
| `subscriptionEscrow` | Tier-3 "rent": recurring subscriptions (`subOffer`, per-period claim/dispute) |
| `stakingVault` | standing collateral: `stake` / `unstake` / `withdrawStake` (arbiter-slashable on adjudicated fault) |
| `yieldVault` | park the agent's **own** idle settlement token for share-accounted yield (never escrow funds) |
| `smartAccount` | ERC-4337 gasless funding (`buildFundCalls` / `buildFundUserOperation`) — needs a live bundler + paymaster |
| `httpTimeoutMs` | override the 15 s HTTP bound |

Absent config ⇒ the corresponding methods throw a clear error instead of dialing anything.

> **Gasless on Robinhood Chain** — account abstraction is first-class on the chain ([official docs](https://docs.robinhood.com/chain/account-abstraction/)): point `smartAccount.bundlerUrl` at an Alchemy (or ZeroDev) bundler for chain 46630, set `paymaster: true` + `paymasterContext: { policyId }` from your funded gas policy, and `fundViaSmartAccount()` batches approve+fund into one sponsored UserOperation. The smart account becomes the deal's **buyer** (it holds the settlement token; buyer-side `confirm`/`dispute`/`withdraw` are also sent as UserOperations from it — see `agents/src/gasless-demo.ts` for the full flow). The operator's gas policy pays the gas.

## API surface

`AgentClient`, `usd6`, protocol constants and types (`OFFER_TYPE`, `SUB_OFFER_TYPE`, `offerToTuple`, `subOfferToTuple`, `DEAL_STATES`, `SUB_STATES`, `OfferJson`, `X402Quote`, …), vendored ABIs (`escrowAbi`, `erc20Abi`, `subscriptionEscrowAbi`), and the ERC-4337 builders (`buildFundCalls`, `buildFundUserOperation`). Everything is exported from the package root — see `src/index.ts`.

The EIP-712 material (domain `AgentEscrow`/`1`, 13-field `Offer`, 15-field `SubOffer`) is pinned field-by-field against `Escrow.sol` / `SubscriptionEscrow.sol` by the test suite, including a from-first-principles digest reconstruction.

## Development

```bash
npm run typecheck && npm test && npm run build   # also the prepublishOnly gate
```

Tests are hermetic (no chain, no Hub): crafted hostile 402 endpoints, stubbed bundlers, real in-process EIP-712 signing. For a live end-to-end run against a local anvil, see the repo's `agents/` arena and `TESTNET.md`.

## License

MIT
