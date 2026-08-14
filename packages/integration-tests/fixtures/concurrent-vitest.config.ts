import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["fixtures/concurrent-harness-peer.test.ts"],
    testTimeout: 120_000,
  },
});
