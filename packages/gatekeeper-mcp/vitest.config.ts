import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/mcp.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
        bindings: {
          BASE_URL: "https://workshop.example/gatekeeper/mcp",
          MCP_ALLOW_INSECURE: "false",
        },
        durableObjects: {
          MCP_ACCOUNT: { className: "McpAccount", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
