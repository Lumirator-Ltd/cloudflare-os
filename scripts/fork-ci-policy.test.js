import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateWorkflowDirectory,
  validateWorkflowText,
} from "./fork-ci-policy.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const ACCEPTED_WORKFLOW = `name: CI

on:
  push:
    branches:
      - main
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - name: Use a pinned action
        uses: example/action@${SHA.toUpperCase()}
      - name: Use a local action
        uses: ./.github/actions/example
      - run: node --test
`;

function validate(text) {
  return validateWorkflowText(text, WORKFLOW_PATH);
}

async function withWorkflowDirectory(files, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "fork-ci-policy-"));
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

test("accepts the single safe CI workflow", () => {
  assert.deepEqual(validate(ACCEPTED_WORKFLOW), []);
});

test("repository workflow directory satisfies the fork CI policy", async () => {
  const directory = path.resolve(import.meta.dirname, "..", ".github/workflows");
  assert.deepEqual(await validateWorkflowDirectory(directory), []);
});

test("only .github/workflows/ci.yml is allowed", async () => {
  await withWorkflowDirectory(
    { "ci.yml": ACCEPTED_WORKFLOW, "extra.yaml": ACCEPTED_WORKFLOW },
    async (directory) => {
      assert.deepEqual(await validateWorkflowDirectory(directory), [
        ".github/workflows/extra.yaml:1: only .github/workflows/ci.yml is allowed",
      ]);
    },
  );
});

test("requires .github/workflows/ci.yml", async () => {
  await withWorkflowDirectory({}, async (directory) => {
    assert.deepEqual(await validateWorkflowDirectory(directory), [
      ".github/workflows/ci.yml:1: required workflow is missing",
    ]);
  });
});

test("rejects every known forbidden workflow name", async (t) => {
  const forbiddenNames = [
    "bonk.yml",
    "bonk-pr.yml",
    "cla.yml",
    "contribution-policy.yml",
    "label-pr.yml",
  ];

  for (const name of forbiddenNames) {
    await t.test(name, async () => {
      await withWorkflowDirectory(
        { "ci.yml": ACCEPTED_WORKFLOW, [name]: ACCEPTED_WORKFLOW },
        async (directory) => {
          assert.deepEqual(await validateWorkflowDirectory(directory), [
            `.github/workflows/${name}:1: only .github/workflows/ci.yml is allowed`,
          ]);
        },
      );
    });
  }
});

test("rejects unsafe workflow triggers", async (t) => {
  for (const trigger of [
    "pull_request_target",
    "issue_comment",
    "issues",
    "workflow_run",
    "schedule",
  ]) {
    await t.test(trigger, () => {
      const workflow = ACCEPTED_WORKFLOW.replace(
        "  pull_request:\n",
        `  pull_request:\n  ${trigger}:\n`,
      );
      assert.match(validate(workflow).join("\n"), new RegExp(`unsafe trigger ${trigger}`));
    });
  }
});

test("rejects triggers other than pull_request and push", () => {
  const workflow = ACCEPTED_WORKFLOW.replace(
    "  pull_request:\n",
    "  pull_request:\n  workflow_dispatch:\n",
  );
  assert.match(validate(workflow).join("\n"), /trigger workflow_dispatch is not allowed/);
});

test("requires push to be scoped only to main", async (t) => {
  await t.test("rejects another branch", () => {
    const workflow = ACCEPTED_WORKFLOW.replace("      - main", "      - release");
    assert.match(validate(workflow).join("\n"), /push branches must be exactly main/);
  });

  await t.test("rejects an additional branch", () => {
    const workflow = ACCEPTED_WORKFLOW.replace(
      "      - main",
      "      - main\n      - release",
    );
    assert.match(validate(workflow).join("\n"), /push branches must be exactly main/);
  });

  await t.test("rejects an inline push mapping", () => {
    const workflow = ACCEPTED_WORKFLOW.replace(
      "  push:\n    branches:\n      - main",
      "  push: { branches: [main] }",
    );
    assert.match(validate(workflow).join("\n"), /push branches must be exactly main/);
  });
});

test("requires exactly top-level contents: read permissions", async (t) => {
  await t.test("rejects write access", () => {
    const workflow = ACCEPTED_WORKFLOW.replace("contents: read", "contents: write");
    assert.match(validate(workflow).join("\n"), /permissions must be exactly contents: read/);
  });

  await t.test("rejects additional permissions", () => {
    const workflow = ACCEPTED_WORKFLOW.replace(
      "  contents: read",
      "  contents: read\n  actions: read",
    );
    assert.match(validate(workflow).join("\n"), /permissions must be exactly contents: read/);
  });

  await t.test("rejects missing permissions", () => {
    const workflow = ACCEPTED_WORKFLOW.replace(
      "permissions:\n  contents: read\n\n",
      "",
    );
    assert.match(validate(workflow).join("\n"), /permissions must be exactly contents: read/);
  });

  await t.test("rejects a job-level override", () => {
    const workflow = ACCEPTED_WORKFLOW.replace(
      "    runs-on: ubuntu-latest",
      "    permissions:\n      contents: read\n    runs-on: ubuntu-latest",
    );
    assert.match(validate(workflow).join("\n"), /job-level permissions are not allowed/);
  });
});

test("rejects privileged credentials and credential persistence", async (t) => {
  const cases = [
    ["id-token write", "  contents: read\n  id-token: write", /id-token: write is not allowed/],
    [
      "GitHub secret expression",
      "      - run: echo '${{ secrets.DEPLOY_TOKEN }}'",
      /secret expressions are not allowed/,
    ],
    [
      "Cloudflare API token name",
      "      - run: echo CLOUDFLARE_API_TOKEN",
      /Cloudflare credential names are not allowed/,
    ],
    [
      "Cloudflare account ID name",
      "      - run: echo CLOUDFLARE_ACCOUNT_ID",
      /Cloudflare credential names are not allowed/,
    ],
    [
      "persisted checkout credentials",
      "          persist-credentials: true",
      /persist-credentials: true is not allowed/,
    ],
  ];

  for (const [name, replacement, expected] of cases) {
    await t.test(name, () => {
      const workflow = ACCEPTED_WORKFLOW.replace(
        name === "id-token write"
          ? "  contents: read"
          : name === "persisted checkout credentials"
            ? "          persist-credentials: false"
            : "      - run: node --test",
        replacement,
      );
      assert.match(validate(workflow).join("\n"), expected);
    });
  }
});

test("rejects GitHub expressions referencing secrets", async (t) => {
  const cases = [
    ["single-quoted bracket notation", "${{ secrets['SINGLE_QUOTED_NAME'] }}"],
    ["double-quoted bracket notation", '${{ secrets["DOUBLE_QUOTED_NAME"] }}'],
    ["expression whitespace", "${{  secrets  [  'SPACED_NAME'  ]  }}"],
    ["nested secret reference", "${{ format('{0}', secrets['NESTED_NAME']) }}"],
    ["whole secrets context", "${{ toJSON(secrets) }}"],
  ];

  for (const [name, expression] of cases) {
    await t.test(name, () => {
      const workflow = ACCEPTED_WORKFLOW.replace(
        "      - run: node --test",
        `      - env:\n          VALUE: ${expression}\n        run: node --test`,
      );
      const secretLine =
        workflow.split("\n").findIndex((line) => line.includes("VALUE:")) + 1;

      assert.deepEqual(validate(workflow), [
        `${WORKFLOW_PATH}:${secretLine}: secret expressions are not allowed`,
      ]);
    });
  }
});

test("accepts prose and comments containing the word secrets", () => {
  const workflow = ACCEPTED_WORKFLOW.replace(
    "      - run: node --test",
    '      # secrets are unavailable\n      - name: Explain secrets policy\n        run: echo "no secrets here"',
  );

  assert.deepEqual(validate(workflow), []);
});

test("requires non-local actions to use a 40-character hexadecimal SHA", async (t) => {
  for (const reference of [
    "actions/setup-node@v4",
    "actions/setup-node@0123456",
    "actions/setup-node@zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  ]) {
    await t.test(reference, () => {
      const workflow = ACCEPTED_WORKFLOW.replace(
        `example/action@${SHA.toUpperCase()}`,
        reference,
      );
      assert.match(validate(workflow).join("\n"), /must use a 40-character hexadecimal SHA/);
    });
  }
});

test("requires every checkout step to disable persisted credentials", async (t) => {
  await t.test("rejects a missing setting", () => {
    const workflow = ACCEPTED_WORKFLOW.replace(
      "        with:\n          persist-credentials: false\n",
      "",
    );
    assert.match(
      validate(workflow).join("\n"),
      /actions\/checkout must set persist-credentials: false/,
    );
  });

  await t.test("rejects a non-false setting", () => {
    const workflow = ACCEPTED_WORKFLOW.replace(
      "persist-credentials: false",
      'persist-credentials: "false"',
    );
    assert.match(
      validate(workflow).join("\n"),
      /actions\/checkout must set persist-credentials: false/,
    );
  });
});

test("diagnostics use stable relative paths and lines without environment values", () => {
  const environmentValue = "must-not-appear-in-diagnostics";
  process.env.CLOUDFLARE_API_TOKEN = environmentValue;
  try {
    const workflow = ACCEPTED_WORKFLOW.replace(
      "      - run: node --test",
      "      - run: echo '${{ secrets.PRIVATE_VALUE }}'",
    );
    const diagnostics = validate(workflow);
    const secretLine = workflow.split("\n").findIndex((line) => line.includes("secrets.")) + 1;

    assert.equal(
      diagnostics.find((diagnostic) => diagnostic.includes("secret expressions")),
      `${WORKFLOW_PATH}:${secretLine}: secret expressions are not allowed`,
    );
    assert.equal(diagnostics.join("\n").includes(environmentValue), false);
    assert.equal(diagnostics.join("\n").includes(tmpdir()), false);
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
});
