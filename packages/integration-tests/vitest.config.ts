import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globalSetup: "./global-setup.ts",
    // Each harness boots real workerd instances, so these run far slower than unit tests.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
