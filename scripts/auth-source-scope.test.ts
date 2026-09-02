import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGE_ROOT = join(ROOT, "packages");
const SERVER = "packages/workshop-backend/src/server.ts";
const IDENTITY_REGISTRY_ALLOWLIST = new Set([
  "packages/workshop-backend/src/identity-registry.ts",
  "packages/workshop-backend/__tests__/identity-registry.test.ts",
  "packages/workshop-backend/__integration__/identity-registry.test.ts",
  "packages/workshop-backend/worker-configuration.d.ts",
  "packages/workshop-backend/wrangler.jsonc",
  "scripts/release/testdata/golden-manifest.json",
]);
const SOURCE_EXTENSIONS = /\.(?:c|m)?(?:j|t)sx?$|\.jsonc?$|\.d\.ts$/;
const FORBIDDEN = [
  /clerk/i,
  /GatekeeperAuthenticationIdentity|getAuthenticationIdentity/,
  /identity-authority|IdentityAuthority|VerifiedAuthorityContext/,
  /absolute-deadline|AbsoluteDeadline|armAbsoluteDeadline/,
  /gatekeeper-session-logout|GATEKEEPER_SESSION_(?:LOGOUT|WATCHDOG|MAX_AGE)/,
  /GatekeeperSession(?:Invalidator|Authentication)/,
  /(?:register|unregister|assert|create|revoke)GatekeeperSession/,
  /handleGatekeeperSessionLogout/,
];
const REGISTRY =
  /IdentityRegistry|identity-registry|resolve(?:Clerk|Gatekeeper)Identity|(?:register|unregister)IdentitySession/;

function productionFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".wrangler" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionFiles(path));
    else if (SOURCE_EXTENSIONS.test(entry.name)) files.push(path);
  }
  return files;
}

function isAllowedRegistryLine(path: string, line: string): boolean {
  if (IDENTITY_REGISTRY_ALLOWLIST.has(path)) return true;
  if (path !== SERVER) return false;
  const source = line.trim();
  return source === 'import { IdentityRegistry } from "./identity-registry.js";' ||
    source === "export { IdentityRegistry };";
}

function findings(): string[] {
  const files = [
    ...productionFiles(PACKAGE_ROOT),
    join(ROOT, "scripts", "dev-server-config.ts"),
    join(ROOT, "pnpm-lock.yaml"),
    join(ROOT, "scripts", "release", "testdata", "golden-manifest.json"),
  ];
  const failures: string[] = [];
  for (const file of files) {
    const path = relative(ROOT, file);
    for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
      if (FORBIDDEN.some(pattern => pattern.test(line))) {
        if (!IDENTITY_REGISTRY_ALLOWLIST.has(path)) failures.push(`${path}:${index + 1}: ${line.trim()}`);
      }
      if (REGISTRY.test(line) && !isAllowedRegistryLine(path, line)) {
        failures.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  return [...new Set(failures)].toSorted();
}

test("active source contains no Clerk or fork identity/session machinery", () => {
  assert.deepEqual(findings(), []);
});

test("the public auth contract has no fork-only RPC or configured presentation field", () => {
  const api = readFileSync(join(ROOT, "packages/workshop-shared/src/api.ts"), "utf8");
  const authVendor = api.slice(
    api.indexOf("export type AuthVendorInfo"),
    api.indexOf("export type ServerConfig"),
  );
  assert.doesNotMatch(api, /authenticateWithClerk|ClerkAuthentication|ClerkSessionControl/);
  assert.doesNotMatch(authVendor, /\bconfigured\b/);
});

test("IdentityRegistry remains exported only for deployed-class compatibility", () => {
  const server = readFileSync(join(ROOT, SERVER), "utf8");
  const registryLines = server.split("\n").filter(line => REGISTRY.test(line)).map(line => line.trim());
  assert.deepEqual(registryLines, [
    'import { IdentityRegistry } from "./identity-registry.js";',
    "export { IdentityRegistry };",
  ]);
});

test("IdentityRegistry and Telegram historical migrations remain append-only", () => {
  const wrangler = readFileSync(join(ROOT, "packages/workshop-backend/wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"tag": "v3",\s*"new_sqlite_classes": \[ "IdentityRegistry" \]/);
  assert.match(wrangler, /"tag": "v4",\s*"new_sqlite_classes": \[ "TelegramChannel" \]/);
  assert.doesNotMatch(wrangler, /deleted_classes/);
});
