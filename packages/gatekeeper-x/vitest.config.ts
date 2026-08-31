import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-08",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
        bindings: {
          BASE_URL: "https://workshop.example/gatekeeper/x",
        },
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          X_ACCOUNT_GATEKEEPER: { className: "XAccountGatekeeperImpl", useSQLite: true },
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
