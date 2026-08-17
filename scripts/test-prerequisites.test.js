import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("test script builds format blueprints before workspace tests", () => {
  assert.deepEqual(packageJson.scripts.test.split(" && "), [
    "node --test scripts/*.test.js",
    "pnpm --filter @gadgets/workshop-backend build:format-blueprints",
    "vp run --filter '!cloudflare-os' --cache test",
  ]);
});
