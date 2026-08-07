/// HERMETIC tests for quoteAndFund's untrusted-seller guards (arbiter policy + window floors) and
/// the SDK-wide HTTP timeout. A tiny local HTTP server plays the (hostile) seller endpoint; a real
/// in-process seller AgentClient signs the quotes so every guard is exercised on genuine EIP-712
/// material. No chain is ever dialed: every case fails (by design) BEFORE fund()'s first RPC call —
/// the signature-stage case proves the guards LET a compliant quote through.
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex, Address } from "viem";
import { AgentClient } from "../src/client.js";
import type { X402Quote } from "../src/types.js";

const CFG = {
  rpcUrl: "http://127.0.0.1:1", // never dialed — all cases stop before any chain call
  chainId: 31337,
  escrow: "0x00000000000000000000000000000000000000e5" as Address,
  usdc: "0x00000000000000000000000000000000000000c1" as Address,
};
const ARBITER = "0x000000000000000000000000000000000000a11c" as Address;
const OTHER = "0x000000000000000000000000000000000000dead" as Address;
const SPEC = "tick-data batch";

const seller = new AgentClient({ ...CFG, privateKey: ("0x" + "0".repeat(63) + "5") as Hex });
const buyer = () => new AgentClient({ ...CFG, privateKey: ("0x" + "0".repeat(63) + "9") as Hex });

function sellerQuote(over?: { confirmWindowS?: number; deliverInS?: number }): Promise<X402Quote> {
  return seller.serveQuote({ spec: SPEC }, () => ({
    arbiter: ARBITER,
    priceUsd: 1,
    buyerBondUsd: 0.1,
    sellerBondUsd: 0.5,
    feeBps: 100,
    deliverInS: over?.deliverInS ?? 3600,
    confirmWindowS: over?.confirmWindowS ?? 7200,
    spec: SPEC,
  }));
}

/// Serve one canned 402 body on a throwaway port, hand the URL to the test, always tear down.
async function with402(body: unknown, fn: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}/x402/quote`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("x402 quoteAndFund — arbiter policy (strict by default)", () => {
  it("REFUSES when neither expectedArbiter nor allowAnyArbiter is given", async () => {
    await with402(await sellerQuote(), async (url) => {
      await expect(buyer().quoteAndFund(url, SPEC)).rejects.toThrow(/expectedArbiter is required/i);
    });
  });

  it("REFUSES a quote whose arbiter is not the pinned expectedArbiter", async () => {
    await with402(await sellerQuote(), async (url) => {
      await expect(buyer().quoteAndFund(url, SPEC, { expectedArbiter: OTHER })).rejects.toThrow(/!= expectedArbiter/i);
    });
  });

  it("REFUSES expectedArbiter combined with allowAnyArbiter (ambiguous intent)", async () => {
    await with402(await sellerQuote(), async (url) => {
      await expect(
        buyer().quoteAndFund(url, SPEC, { expectedArbiter: ARBITER, allowAnyArbiter: true }),
      ).rejects.toThrow(/mutually exclusive/i);
    });
  });
});

describe("x402 quoteAndFund — window floors", () => {
  it("REFUSES a confirmWindow below the default 600s floor (contract only rejects 0)", async () => {
    await with402(await sellerQuote({ confirmWindowS: 1 }), async (url) => {
      await expect(buyer().quoteAndFund(url, SPEC, { expectedArbiter: ARBITER })).rejects.toThrow(/below minConfirmWindowS/i);
    });
  });

  it("REFUSES a deliverDeadline nearer than the default 60s floor", async () => {
    await with402(await sellerQuote({ deliverInS: 5 }), async (url) => {
      await expect(buyer().quoteAndFund(url, SPEC, { expectedArbiter: ARBITER })).rejects.toThrow(/below minDeliverWindowS/i);
    });
  });

  it("floors are caller-tunable: the same short quote passes explicit lower floors (and then fails at the NEXT guard)", async () => {
    // maxPriceUsdc below the quoted price ⇒ if the window guards pass, the ceiling fires — proving
    // the tunables actually lowered the floors rather than the guard being skipped.
    await with402(await sellerQuote({ confirmWindowS: 30, deliverInS: 30 }), async (url) => {
      await expect(
        buyer().quoteAndFund(url, SPEC, {
          expectedArbiter: ARBITER,
          minConfirmWindowS: 10,
          minDeliverWindowS: 10,
          maxPriceUsdc: 1n,
        }),
      ).rejects.toThrow(/exceeds maxPriceUsdc/i);
    });
  });

  it("a compliant quote passes ALL guards and reaches the signature stage (tampered sig ⇒ its error)", async () => {
    const q = await sellerQuote();
    const sig = q.signature as string;
    const r0 = sig.slice(2, 4);
    const tampered = { ...q, signature: ("0x" + (r0 === "ab" ? "cd" : "ab") + sig.slice(4)) as Hex };
    await with402(tampered, async (url) => {
      await expect(buyer().quoteAndFund(url, SPEC, { expectedArbiter: ARBITER })).rejects.toThrow(/signature does not recover/i);
    });
  });
});

describe("HTTP timeout (httpTimeoutMs)", () => {
  it("quote() against a hanging endpoint rejects with a clear timeout error (never hangs)", async () => {
    // Accept the request and never respond — Node fetch would otherwise wait forever.
    const server: Server = createServer(() => { /* hold the socket open */ });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const b = new AgentClient({ ...CFG, privateKey: ("0x" + "0".repeat(63) + "9") as Hex, httpTimeoutMs: 300 });
      await expect(b.quote(`http://127.0.0.1:${port}/x402/quote`, SPEC)).rejects.toThrow(/timed out after 300ms/i);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Hub relay calls are bounded too (postSignedOffer against a hanging Hub)", async () => {
    const server: Server = createServer(() => { /* hold the socket open */ });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const s = new AgentClient({
        ...CFG,
        privateKey: ("0x" + "0".repeat(63) + "5") as Hex,
        hubUrl: `http://127.0.0.1:${port}`,
        httpTimeoutMs: 300,
      });
      const offer = s.buildOffer({ arbiter: ARBITER, priceUsd: 1, buyerBondUsd: 0, sellerBondUsd: 0, feeBps: 100, deliverInS: 3600, confirmWindowS: 7200, spec: SPEC });
      const signature = await s.signOffer(offer);
      await expect(s.postSignedOffer(offer, signature)).rejects.toThrow(/timed out after 300ms/i);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
