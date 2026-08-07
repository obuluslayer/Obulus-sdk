import { defineConfig } from "vitest/config";

// Hermetic SDK unit tests. The smart-account (ERC-4337) transport is exercised with a STUBBED bundler
// — no live bundler RPC, Paymaster, or chain is ever contacted (see test/smartAccount.test.ts).
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
