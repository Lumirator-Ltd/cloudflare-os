import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("test script builds format blueprints before workspace tests", () => {
  assert.deepEqual(packageJson.scripts.test.split(" && "), [
    "node --test 'scripts/**/*.test.ts' scripts/*.test.js",
    "vp run --filter @gadgets/workshop-backend --no-cache build:format-blueprints",
    "vp run --filter '!cloudflare-os' --cache test",
  ]);
});

test("fork cannot expose upstream preview deployment paths", async () => {
  assert.deepEqual(
    Object.keys(packageJson.scripts).filter((name) => name.startsWith("preview:")),
    [],
  );
  await assert.rejects(access(new URL("../.github/workflows/preview.yml", import.meta.url)));
  await assert.rejects(access(new URL("./preview", import.meta.url)));
});
