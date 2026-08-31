import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
        bindings: {
          BASE_URL: "https://workshop.example/gatekeeper/hubspot",
          CLIENT_ID: "hubspot-client-id",
          CLIENT_SECRET: "hubspot-client-secret",
        },
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          HUBSPOT_GATEKEEPER: { className: "TestHubSpotGatekeeper", useSQLite: true },
          TEST_CALLBACK_STORE: { className: "TestCallbackStore", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
