import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import * as policy from "./fork-ci-policy.mjs";

const execFile = promisify(execFileCallback);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CI_PATH = ".github/workflows/ci.yml";
const POLICY_PATH = ".github/workflows/policy.yml";
const SCRIPT_PATH = path.resolve(import.meta.dirname, "fork-ci-policy.mjs");
const PROTECTED_PATHS = [
  CI_PATH,
  POLICY_PATH,
  "scripts/fork-ci-policy.mjs",
  "scripts/fork-ci-policy.test.js",
];

const ACCEPTED_CI = `name: CI

on:
  push:
    branches:
      - main
  pull_request:

permissions:
  contents: read

jobs:
  lint-and-build:
    name: Lint and build
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Check out repository
        uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - name: Use a pinned action
        uses: example/action@${SHA.toUpperCase()}
      - run: node scripts/example.mjs
`;

const ACCEPTED_POLICY = `name: Policy

on:
  pull_request_target:
    types:
      - opened
      - synchronize
      - reopened
      - ready_for_review

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  policy:
    name: Policy
    runs-on: ubuntu-latest
    timeout-minutes: 5
    env:
      PR_NUMBER: \${{ github.event.pull_request.number }}
    steps:
      - name: Check out trusted base
        uses: actions/checkout@${SHA}
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Validate pull request number
        run: |
          if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
            echo "Invalid pull request number" >&2
            exit 1
          fi

      - name: Fetch candidate as Git data
        run: git fetch --no-tags origin "refs/pull/\${PR_NUMBER}/head:refs/remotes/policy/pr-head"

      - name: Test trusted policy
        run: node --test scripts/fork-ci-policy.test.js

      - name: Check candidate policy
        run: node scripts/fork-ci-policy.mjs --revision refs/remotes/policy/pr-head --base-revision HEAD
`;

function validate(text, filePath = CI_PATH) {
  return policy.validateWorkflowText(text, filePath);
}

async function withWorkflowDirectory(files, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "fork-ci-policy-workflows-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, contents]) =>
        writeFile(path.join(directory, name), contents),
      ),
    );
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function git(repository, ...args) {
  const { stdout } = await execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function writeRepositoryFile(repository, filePath, contents) {
  const absolutePath = path.join(repository, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

async function withGitFixture(mutate, callback) {
  const repository = await mkdtemp(path.join(tmpdir(), "fork-ci-policy-git-"));
  try {
    await git(repository, "init", "--quiet");
    await git(repository, "config", "user.email", "policy@example.invalid");
    await git(repository, "config", "user.name", "Policy Test");
    await writeRepositoryFile(repository, CI_PATH, ACCEPTED_CI);
    await writeRepositoryFile(repository, POLICY_PATH, ACCEPTED_POLICY);
    await writeRepositoryFile(repository, "scripts/fork-ci-policy.mjs", "export {};\n");
    await writeRepositoryFile(repository, "scripts/fork-ci-policy.test.js", "export {};\n");
    await writeRepositoryFile(repository, "src/existing.js", "export const value = 1;\n");
    await git(repository, "add", "--all");
    await git(repository, "commit", "--quiet", "-m", "base");
    const baseRevision = await git(repository, "rev-parse", "HEAD");

    await mutate(repository);
    await git(repository, "add", "--all");
    await git(repository, "commit", "--quiet", "-m", "candidate");
    const revision = await git(repository, "rev-parse", "HEAD");

    assert.equal(typeof policy.validateGitRevision, "function");
    await callback({
      repository,
      baseRevision,
      revision,
      diagnostics: await policy.validateGitRevision({
        repository,
        revision,
        baseRevision,
      }),
    });
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function runPolicyCli(args, env = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a one-workflow directory fails because policy.yml is missing", async () => {
  await withWorkflowDirectory({ "ci.yml": ACCEPTED_CI }, async (directory) => {
    assert.deepEqual(await policy.validateWorkflowDirectory(directory), [
      `${POLICY_PATH}:1: required workflow is missing`,
    ]);
  });
});

test("accepts exactly the trusted CI and policy workflows", async () => {
  await withWorkflowDirectory(
    { "ci.yml": ACCEPTED_CI, "policy.yml": ACCEPTED_POLICY },
    async (directory) => {
      assert.deepEqual(await policy.validateWorkflowDirectory(directory), []);
    },
  );
});

test("repository workflow directory satisfies the fork CI policy", async () => {
  const directory = path.resolve(import.meta.dirname, "..", ".github/workflows");
  assert.deepEqual(await policy.validateWorkflowDirectory(directory), []);
});

test("rejects any third workflow", async () => {
  await withWorkflowDirectory(
    {
      "ci.yml": ACCEPTED_CI,
      "policy.yml": ACCEPTED_POLICY,
      "extra.yaml": ACCEPTED_CI,
    },
    async (directory) => {
      const diagnostics = await policy.validateWorkflowDirectory(directory);
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /only ci\.yml and policy\.yml are allowed/);
    },
  );
});

test("pull_request_target is rejected by ci.yml and accepted only by policy.yml", () => {
  const unsafeCi = ACCEPTED_CI.replace(
    "  pull_request:\n",
    "  pull_request:\n  pull_request_target:\n",
  );
  assert.match(validate(unsafeCi).join("\n"), /unsafe trigger pull_request_target/);
  assert.deepEqual(validate(ACCEPTED_POLICY, POLICY_PATH), []);
});

test("ci.yml requires only pull_request and push to main", async (t) => {
  await t.test("rejects another trigger", () => {
    const workflow = ACCEPTED_CI.replace(
      "  pull_request:\n",
      "  pull_request:\n  workflow_dispatch:\n",
    );
    assert.match(validate(workflow).join("\n"), /trigger workflow_dispatch is not allowed/);
  });

  await t.test("rejects another push branch", () => {
    const workflow = ACCEPTED_CI.replace("      - main", "      - release");
    assert.match(validate(workflow).join("\n"), /push branches must be exactly main/);
  });
});

test("policy.yml rejects every other trigger and activity contract", async (t) => {
  await t.test("rejects another trigger", () => {
    const workflow = ACCEPTED_POLICY.replace(
      "  pull_request_target:\n",
      "  pull_request_target:\n  workflow_dispatch:\n",
    );
    assert.match(
      validate(workflow, POLICY_PATH).join("\n"),
      /triggers must be exactly pull_request_target/,
    );
  });

  await t.test("rejects a missing activity", () => {
    const workflow = ACCEPTED_POLICY.replace("      - ready_for_review\n", "");
    assert.match(
      validate(workflow, POLICY_PATH).join("\n"),
      /activity types must be exactly/,
    );
  });

  await t.test("rejects an extra activity", () => {
    const workflow = ACCEPTED_POLICY.replace(
      "      - ready_for_review",
      "      - ready_for_review\n      - closed",
    );
    assert.match(
      validate(workflow, POLICY_PATH).join("\n"),
      /activity types must be exactly/,
    );
  });
});

test("policy checkout must use the exact trusted base SHA", async (t) => {
  for (const [name, replacement] of [
    ["head SHA", "${{ github.event.pull_request.head.sha }}"],
    ["merge ref", "refs/pull/${{ github.event.pull_request.number }}/merge"],
    ["candidate ref", "refs/remotes/policy/pr-head"],
  ]) {
    await t.test(name, () => {
      const workflow = ACCEPTED_POLICY.replace(
        "${{ github.event.pull_request.base.sha }}",
        replacement,
      );
      assert.match(
        validate(workflow, POLICY_PATH).join("\n"),
        /checkout must use the exact pull request base SHA/,
      );
    });
  }
});

test("policy workflow rejects untrusted execution capabilities", async (t) => {
  const cases = [
    [
      "candidate checkout command",
      "run: git fetch --no-tags origin",
      "run: git checkout refs/remotes/policy/pr-head",
    ],
    [
      "local action",
      `run: node --test scripts/fork-ci-policy.test.js`,
      "uses: ./.github/actions/candidate",
    ],
    [
      "setup-node action",
      `run: node --test scripts/fork-ci-policy.test.js`,
      `uses: actions/setup-node@${SHA}`,
    ],
    [
      "package manager",
      `run: node --test scripts/fork-ci-policy.test.js`,
      "run: pnpm install --frozen-lockfile",
    ],
    [
      "install command",
      `run: node --test scripts/fork-ci-policy.test.js`,
      "run: npm install",
    ],
    [
      "build command",
      `run: node --test scripts/fork-ci-policy.test.js`,
      "run: node scripts/build.mjs",
    ],
    [
      "candidate test command",
      `run: node --test scripts/fork-ci-policy.test.js`,
      "run: node --test candidate.test.js",
    ],
    [
      "secret reference",
      `run: node --test scripts/fork-ci-policy.test.js`,
      "run: echo '${{ secrets['CANARY_SECRET_NAME'] }}'",
    ],
    [
      "permissions override",
      "    runs-on: ubuntu-latest",
      "    permissions:\n      contents: write\n    runs-on: ubuntu-latest",
    ],
    [
      "mutable action",
      `actions/checkout@${SHA}`,
      "actions/checkout@v4",
    ],
    [
      "missing persist-credentials false",
      "          persist-credentials: false\n",
      "",
    ],
  ];

  for (const [name, target, replacement] of cases) {
    await t.test(name, () => {
      const diagnostics = validate(
        ACCEPTED_POLICY.replace(target, replacement),
        POLICY_PATH,
      );
      assert.notDeepEqual(diagnostics, []);
    });
  }
});

test("policy workflow requires the trusted fetch and checker sequence", async (t) => {
  const cases = [
    ["numeric PR validation", '[[ "$PR_NUMBER" =~ ^[0-9]+$ ]]', "true"],
    [
      "quoted pull-ref fetch",
      '"refs/pull/${PR_NUMBER}/head:refs/remotes/policy/pr-head"',
      "refs/pull/${PR_NUMBER}/head:refs/remotes/policy/pr-head",
    ],
    [
      "trusted base test",
      "node --test scripts/fork-ci-policy.test.js",
      "node --test scripts/other.test.js",
    ],
    [
      "revision checker invocation",
      "node scripts/fork-ci-policy.mjs --revision refs/remotes/policy/pr-head --base-revision HEAD",
      "node scripts/fork-ci-policy.mjs",
    ],
  ];

  for (const [name, target, replacement] of cases) {
    await t.test(name, () => {
      const diagnostics = validate(
        ACCEPTED_POLICY.replace(target, replacement),
        POLICY_PATH,
      );
      assert.notDeepEqual(diagnostics, []);
    });
  }
});

test("both workflows require exactly contents read and pinned non-local actions", async (t) => {
  for (const [filePath, workflow] of [
    [CI_PATH, ACCEPTED_CI],
    [POLICY_PATH, ACCEPTED_POLICY],
  ]) {
    await t.test(filePath, async (t) => {
      await t.test("rejects write permissions", () => {
        assert.match(
          validate(workflow.replace("contents: read", "contents: write"), filePath).join(
            "\n",
          ),
          /permissions must be exactly contents: read/,
        );
      });
      await t.test("rejects a mutable action", () => {
        assert.match(
          validate(workflow.replace(`actions/checkout@${SHA}`, "actions/checkout@v4"), filePath).join(
            "\n",
          ),
          /40-character hexadecimal SHA/,
        );
      });
    });
  }
});

test("both workflows reject dot and bracket secret references and Cloudflare credentials", async (t) => {
  const expressions = [
    "${{ secrets.DEPLOY_TOKEN }}",
    "${{ secrets['SINGLE_QUOTED_NAME'] }}",
    '${{ secrets["DOUBLE_QUOTED_NAME"] }}',
    "${{ toJSON(secrets) }}",
  ];

  for (const expression of expressions) {
    await t.test(expression.replaceAll(/[A-Z_]+/g, "VALUE"), () => {
      const workflow = ACCEPTED_CI.replace(
        "      - run: node scripts/example.mjs",
        `      - env:\n          VALUE: ${expression}\n        run: node scripts/example.mjs`,
      );
      assert.match(validate(workflow).join("\n"), /secret expressions are not allowed/);
    });
  }

  assert.match(
    validate(ACCEPTED_CI.replace("node scripts/example.mjs", "echo CLOUDFLARE_API_TOKEN")).join(
      "\n",
    ),
    /Cloudflare credential names are not allowed/,
  );
});

test("requires every checkout to disable persisted credentials", () => {
  const workflow = ACCEPTED_CI.replace(
    "        with:\n          persist-credentials: false\n",
    "",
  );
  assert.match(
    validate(workflow).join("\n"),
    /actions\/checkout must set persist-credentials: false/,
  );
});

test("trusted Git revisions accept only fixed policy refs and object IDs", () => {
  assert.equal(policy.isTrustedGitRevision("HEAD"), true);
  assert.equal(policy.isTrustedGitRevision("refs/remotes/policy/pr-head"), true);
  assert.equal(policy.isTrustedGitRevision(SHA), true);
  assert.equal(policy.isTrustedGitRevision("refs/pull/1/head"), false);
  assert.equal(policy.isTrustedGitRevision("--upload-pack=canary"), false);
});

test("revision validation accepts ordinary source changes with protected files unchanged", async () => {
  await withGitFixture(
    async (repository) => {
      await writeRepositoryFile(repository, "src/existing.js", "export const value = 2;\n");
    },
    async ({ diagnostics }) => {
      assert.deepEqual(diagnostics, []);
    },
  );
});

test("revision validation rejects modification and deletion of every protected file", async (t) => {
  for (const protectedPath of PROTECTED_PATHS) {
    await t.test(`modifies ${protectedPath}`, async () => {
      await withGitFixture(
        async (repository) => {
          const contents = await readFile(path.join(repository, protectedPath), "utf8");
          await writeRepositoryFile(repository, protectedPath, `${contents}\n`);
        },
        async ({ diagnostics }) => {
          assert.notDeepEqual(diagnostics, []);
        },
      );
    });

    await t.test(`deletes ${protectedPath}`, async () => {
      await withGitFixture(
        async (repository) => {
          await rm(path.join(repository, protectedPath));
        },
        async ({ diagnostics }) => {
          assert.notDeepEqual(diagnostics, []);
        },
      );
    });
  }
});

test("revision validation reads candidate workflows as inert data", async () => {
  await withGitFixture(
    async (repository) => {
      const workflow = ACCEPTED_CI.replace(
        "  pull_request:\n",
        "  pull_request:\n  pull_request_target:\n",
      );
      await writeRepositoryFile(repository, CI_PATH, workflow);
    },
    async ({ repository, revision }) => {
      const diagnostics = await policy.validateGitRevision({
        repository,
        revision,
        baseRevision: revision,
      });
      assert.notDeepEqual(diagnostics, []);
    },
  );
});

test("revision validation rejects every added workflow", async () => {
  await withGitFixture(
    async (repository) => {
      await writeRepositoryFile(repository, ".github/workflows/extra.yml", ACCEPTED_CI);
    },
    async ({ diagnostics }) => {
      assert.notDeepEqual(diagnostics, []);
    },
  );
});

test("revision validation never executes or imports candidate scripts", async () => {
  let sentinel;
  await withGitFixture(
    async (repository) => {
      sentinel = path.join(repository, "candidate-executed");
      await writeRepositoryFile(
        repository,
        "scripts/candidate-canary.mjs",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "executed");\n`,
      );
      await writeRepositoryFile(repository, "src/ordinary-change.js", "export const ok = true;\n");
    },
    async ({ diagnostics }) => {
      assert.deepEqual(diagnostics, []);
      await assert.rejects(access(sentinel), { code: "ENOENT" });
    },
  );
});

test("revision and CLI diagnostics never disclose untrusted inputs", async () => {
  const canaryRef = "--canary-ref-value";
  const environmentValue = "canary-environment-value";
  const secretName = "CANARY_CREDENTIAL_NAME";
  const secretValue = "canary-candidate-file-value";
  process.env.POLICY_CANARY = environmentValue;
  try {
    assert.equal(typeof policy.validateGitRevision, "function");
    const invalidDiagnostics = await policy.validateGitRevision({
      repository: process.cwd(),
      revision: canaryRef,
      baseRevision: "HEAD",
    });
    assert.notDeepEqual(invalidDiagnostics, []);

    await withGitFixture(
      async (repository) => {
        await writeRepositoryFile(
          repository,
          `.github/workflows/${secretName}.yml`,
          `name: ${secretValue}\nrun: \${{ secrets['${secretName}'] }}\n`,
        );
      },
      async ({ diagnostics }) => {
        const output = [...invalidDiagnostics, ...diagnostics].join("\n");
        for (const canary of [
          canaryRef,
          environmentValue,
          secretName,
          secretValue,
        ]) {
          assert.equal(output.includes(canary), false);
        }
      },
    );

    for (const args of [
      ["--revision", canaryRef],
      ["--base-revision", "HEAD", "--revision", canaryRef],
    ]) {
      const cli = await runPolicyCli(args, {
        ...process.env,
        POLICY_CANARY: environmentValue,
      });
      assert.equal(cli.code, 1);
      for (const canary of [canaryRef, environmentValue]) {
        assert.equal(`${cli.stdout}${cli.stderr}`.includes(canary), false);
      }
    }
  } finally {
    delete process.env.POLICY_CANARY;
  }
});
