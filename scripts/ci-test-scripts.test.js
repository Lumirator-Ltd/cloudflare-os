import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

function jobBlock(workflow, jobId) {
  const match = workflow.match(
    new RegExp(
      `^  ${jobId}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
      "m",
    ),
  );
  assert.ok(match, `missing CI job: ${jobId}`);
  return match[1];
}

test("unit and integration test commands have separate deterministic contracts", () => {
  const rootPackage = readJson("package.json");
  const backendPackage = readJson("packages/workshop-backend/package.json");
  const unitRunner = readText("scripts/run-unit-tests.mjs");
  const integrationRunner = readText("scripts/run-integration-tests.mjs");
  const workflow = readText(".github/workflows/ci.yml");

  assert.equal(
    backendPackage.scripts["test:unit"],
    "node build-browser-runtime.mjs && node scripts/build-format-blueprints.mjs && vitest run",
  );
  assert.doesNotMatch(backendPackage.scripts["test:unit"], /integration/i);
  assert.equal(
    backendPackage.scripts.test,
    "pnpm test:unit && pnpm test:integration",
  );

  assert.equal(rootPackage.scripts["test:unit"], "node scripts/run-unit-tests.mjs");
  assert.equal(
    rootPackage.scripts["test:integration"],
    "node scripts/run-integration-tests.mjs",
  );
  assert.equal(rootPackage.scripts.test, "pnpm test:unit && pnpm test:integration");

  assert.match(unitRunner, /node["'], \["--test", "scripts\/\*\.test\.js"\]/);
  assert.match(unitRunner, /!@gadgets\/integration-tests/);
  assert.match(unitRunner, /!@gadgets\/workshop-backend/);
  assert.match(unitRunner, /@gadgets\/workshop-backend["'], "test:unit/);
  assert.ok(
    unitRunner.indexOf('scripts/*.test.js') <
      unitRunner.indexOf("!@gadgets/integration-tests") &&
      unitRunner.indexOf("!@gadgets/integration-tests") <
        unitRunner.indexOf("@gadgets/workshop-backend"),
    "unit test phases must run in the required order",
  );
  assert.doesNotMatch(
    unitRunner,
    /run-unit-tests\.mjs["']\s*\)/,
    "the unit runner must not invoke itself",
  );

  assert.match(
    integrationRunner,
    /@gadgets\/workshop-backend["'], "test:integration/,
  );
  assert.match(integrationRunner, /@gadgets\/integration-tests["'], "test/);
  assert.ok(
    integrationRunner.indexOf("@gadgets/workshop-backend") <
      integrationRunner.indexOf("@gadgets/integration-tests"),
    "backend integration tests must run before the integration-tests package",
  );

  const expectedJobs = [
    ["lint", "Lint", "pnpm lint"],
    ["build", "Build", "pnpm build"],
    ["unit-tests", "Unit tests", "pnpm test:unit"],
    ["integration-tests", "Integration tests", "pnpm test:integration"],
  ];
  for (const [jobId, name, command] of expectedJobs) {
    const block = jobBlock(workflow, jobId);
    assert.match(block, new RegExp(`^    name: ${name}$`, "m"));
    assert.match(block, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(block, /actions\/setup-node@[0-9a-f]{40}/);
    assert.match(block, /^        run: corepack enable$/m);
    assert.match(block, /^        run: pnpm install --frozen-lockfile$/m);
    assert.match(block, new RegExp(`^        run: ${command.replace(".", "\\.")}$`, "m"));
  }
});
