import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const connectors = [
  ["cloudflare", "cloudflare.ts"],
  ["confluence", "confluence.ts"],
  ["github", "github.ts"],
  ["google", "google.ts"],
  ["linear", "linear.ts"],
  ["notion", "notion.ts"],
  ["slack", "slack.ts"],
  ["spotify", "spotify.ts"],
  ["supabase", "supabase.ts"],
  ["zoominfo", "zoominfo.ts"],
];

for (const [vendorId, fileName] of connectors) {
  test(`${vendorId} vendor description uses shared static OAuth readiness`, () => {
    const source = readFileSync(
      `${root}/packages/gatekeeper-${vendorId}/src/${fileName}`,
      "utf8",
    );

    assert.match(source, /staticOauthConnectorConfiguration/);
    assert.match(
      source,
      /configuration:\s*staticOauthConnectorConfiguration\(this\.env\)/,
    );
  });
}
