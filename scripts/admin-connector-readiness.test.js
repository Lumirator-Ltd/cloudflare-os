import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const configurationSource = readFileSync(
  `${root}/packages/workshop-backend/src/connector-configuration.ts`,
  "utf8",
);

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
  test(`${vendorId} has a local setup guide`, () => {
    assert.equal(existsSync(`${root}/packages/gatekeeper-${vendorId}/README.md`), true);
  });

  test(`${vendorId} vendor description uses shared static OAuth readiness`, () => {
    const source = readFileSync(
      `${root}/packages/gatekeeper-${vendorId}/src/${fileName}`,
      "utf8",
    );

    assert.match(source, /\bCLIENT_ID\b/);
    assert.match(source, /\bCLIENT_SECRET\b/);
    assert.match(source, /staticOauthConnectorConfiguration/);
    assert.match(
      source,
      /configuration:\s*staticOauthConnectorConfiguration\(this\.env\)/,
    );
  });

  test(`${vendorId} has a server-owned HTTPS setup guide`, () => {
    if (vendorId === "linear") {
      assert.match(configurationSource, /linear:\s*"https:\/\/linear\.app\/developers\/oauth-2-0-authentication"/);
    } else {
      const expected = `${vendorId}: \`\${README_BASE_URL}/gatekeeper-${vendorId}#readme\`,`;
      assert.equal(configurationSource.includes(expected), true);
    }
  });
}
