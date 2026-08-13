import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  integrationTestCommands,
  main as runIntegrationTests,
} from "./run-integration-tests.mjs";
import { main as runUnitTests, unitTestCommands } from "./run-unit-tests.mjs";
import { pnpmExecutable } from "./test-runner.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

const rootTestFiles = [
  "scripts/build-gatekeeper-configurator.test.js",
  "scripts/ci-test-scripts.test.js",
  "scripts/dev-server-config.test.js",
  "scripts/release-hash.test.js",
  "scripts/release-manifest.test.js",
  "scripts/release-promote.test.js",
];

const expectedUnitCommands = [
  {
    executable: process.execPath,
    args: ["--test", ...rootTestFiles],
  },
  {
    executable: "pnpm",
    args: [
      "--filter",
      "!@gadgets/integration-tests",
      "--filter",
      "!@gadgets/workshop-backend",
      "--recursive",
      "--if-present",
      "test",
    ],
  },
  {
    executable: "pnpm",
    args: ["--filter", "@gadgets/workshop-backend", "test:unit"],
  },
];

const expectedIntegrationCommands = [
  {
    executable: "pnpm",
    args: ["--filter", "@gadgets/workshop-backend", "test:integration"],
  },
  {
    executable: "pnpm",
    args: ["--filter", "@gadgets/integration-tests", "test"],
  },
];

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

function assertImmutableCommands(commands) {
  assert.ok(Object.isFrozen(commands));
  for (const command of commands) {
    assert.ok(Object.isFrozen(command));
    assert.ok(Object.isFrozen(command.args));
  }
}

for (const runner of ["run-unit-tests.mjs", "run-integration-tests.mjs"]) {
  test(`importing ${runner} does not execute test commands`, () => {
    const runnerUrl = pathToFileURL(resolve("scripts", runner)).href;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(runnerUrl)})`],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: "" },
      },
    );

    assert.equal(result.status, 0, result.stderr);
  });
}

test("unit and integration runners expose exact immutable command contracts", () => {
  const unitCommands = unitTestCommands("linux");
  const integrationCommands = integrationTestCommands("linux");

  assert.deepEqual(unitCommands, expectedUnitCommands);
  assert.deepEqual(integrationCommands, expectedIntegrationCommands);
  assertImmutableCommands(unitCommands);
  assertImmutableCommands(integrationCommands);
});

test("pnpm executable uses the Windows command shim", () => {
  assert.equal(pnpmExecutable("win32"), "pnpm.cmd");
  assert.equal(pnpmExecutable("linux"), "pnpm");

  for (const command of unitTestCommands("win32").slice(1)) {
    assert.equal(command.executable, "pnpm.cmd");
  }
  for (const command of integrationTestCommands("win32")) {
    assert.equal(command.executable, "pnpm.cmd");
  }
});

test("runner mains execute commands in order with inherited stdio", () => {
  const unitCalls = [];
  const integrationCalls = [];
  const executeUnit = (executable, args, options) => {
    unitCalls.push({ executable, args, options });
    return { status: 0 };
  };
  const executeIntegration = (executable, args, options) => {
    integrationCalls.push({ executable, args, options });
    return { status: 0 };
  };

  assert.equal(runUnitTests(executeUnit, "linux"), 0);
  assert.equal(runIntegrationTests(executeIntegration, "linux"), 0);
  assert.deepEqual(
    unitCalls,
    expectedUnitCommands.map((command) => ({
      ...command,
      options: { stdio: "inherit" },
    })),
  );
  assert.deepEqual(
    integrationCalls,
    expectedIntegrationCommands.map((command) => ({
      ...command,
      options: { stdio: "inherit" },
    })),
  );
});

test("runner main immediately propagates a nonzero command status", () => {
  const calls = [];
  const execute = (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: calls.length === 2 ? 23 : 0 };
  };

  assert.equal(runUnitTests(execute, "linux"), 23);
  assert.deepEqual(
    calls,
    expectedUnitCommands.slice(0, 2).map((command) => ({
      ...command,
      options: { stdio: "inherit" },
    })),
  );
});

test("unit and integration test commands remain separately wired into CI", () => {
  const rootPackage = readJson("package.json");
  const backendPackage = readJson("packages/workshop-backend/package.json");
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
