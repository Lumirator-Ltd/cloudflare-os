#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const WORKFLOW_DIRECTORY = ".github/workflows";
const CI_PATH = `${WORKFLOW_DIRECTORY}/ci.yml`;
const POLICY_PATH = `${WORKFLOW_DIRECTORY}/policy.yml`;
const WORKFLOW_PATHS = [CI_PATH, POLICY_PATH];
const PROTECTED_PATHS = [
  ...WORKFLOW_PATHS,
  "scripts/fork-ci-policy.mjs",
  "scripts/fork-ci-policy.test.js",
];
const CI_TRIGGERS = new Set(["pull_request", "push"]);
const UNSAFE_CI_TRIGGERS = new Set([
  "pull_request_target",
  "issue_comment",
  "issues",
  "workflow_run",
  "schedule",
]);
const POLICY_ACTIVITY_TYPES = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "edited",
];
const CHECKOUT_ACTION = "actions/checkout";
const POLICY_BASE_SHA = "${{ github.event.pull_request.base.sha }}";
const POLICY_PR_NUMBER = "${{ github.event.pull_request.number }}";
const POLICY_HEAD_SHA = "${{ github.event.pull_request.head.sha }}";
const POLICY_CONCURRENCY = "${{ github.workflow }}-${{ github.event.pull_request.number }}";
const POLICY_INPUT_CHECK = [
  'if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then',
  'echo "Invalid pull request event" >&2',
  "exit 1",
  "fi",
  'if ! [[ "$HEAD_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then',
  'echo "Invalid pull request event" >&2',
  "exit 1",
  "fi",
].join("\n");
const POLICY_FETCH = [
  'if ! git fetch --no-tags origin "refs/pull/${PR_NUMBER}/head:refs/remotes/policy/pr-head" >/dev/null 2>&1; then',
  'echo "Pull request head validation failed" >&2',
  "exit 1",
  "fi",
].join("\n");
const POLICY_HEAD_CHECK = [
  'fetched_head="$(git rev-parse --verify \'refs/remotes/policy/pr-head^{commit}\' 2>/dev/null)" || {',
  'echo "Pull request head validation failed" >&2',
  "exit 1",
  "}",
  'if [[ "$fetched_head" != "$HEAD_SHA" ]]; then',
  'echo "Pull request head validation failed" >&2',
  "exit 1",
  "fi",
].join("\n");
const POLICY_TEST = "node --test scripts/fork-ci-policy.test.js";
const POLICY_CHECK =
  'node scripts/fork-ci-policy.mjs --revision "$HEAD_SHA" --base-revision HEAD';
const GENERIC_REVISION_DIAGNOSTIC = "pull request policy validation failed";
const GIT_OPTIONS = {
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
};

function stripComment(line) {
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "'" && !doubleQuoted) {
      if (singleQuoted && line[index + 1] === "'") {
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
    } else if (
      character === '"' &&
      !singleQuoted &&
      line[index - 1] !== "\\"
    ) {
      doubleQuoted = !doubleQuoted;
    } else if (character === "#" && !singleQuoted && !doubleQuoted) {
      return line.slice(0, index).trimEnd();
    }
  }

  return line.trimEnd();
}

function indentation(line) {
  return line.match(/^ */)[0].length;
}

function keyValue(line) {
  const content = stripComment(line).trim();
  const match = content.match(/^(?:-\s+)?([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
  if (!match) return null;
  return { key: match[1], value: match[2].trim() };
}

function blockEnd(lines, start, indent) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const content = stripComment(lines[index]);
    if (content.trim() && indentation(content) <= indent) return index;
  }
  return lines.length;
}

function directKeys(lines, start, end, parentIndent) {
  const candidates = [];
  for (let index = start + 1; index < end; index += 1) {
    const parsed = keyValue(lines[index]);
    const indent = indentation(lines[index]);
    if (parsed && indent > parentIndent) {
      candidates.push({ ...parsed, index, indent });
    }
  }
  if (candidates.length === 0) return [];
  const directIndent = Math.min(...candidates.map(({ indent }) => indent));
  return candidates.filter(({ indent }) => indent === directIndent);
}

function topLevelEntries(lines, key) {
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = keyValue(lines[index]);
    if (parsed?.key === key && indentation(lines[index]) === 0) {
      entries.push({ ...parsed, index, indent: 0 });
    }
  }
  return entries;
}

function listValues(lines, start, end, parentIndent) {
  const values = [];
  for (let index = start + 1; index < end; index += 1) {
    const content = stripComment(lines[index]).trim();
    if (indentation(lines[index]) <= parentIndent) break;
    const match = content.match(/^-\s+(.+)$/);
    if (match) values.push(unquote(match[1]));
  }
  return values;
}

function diagnostic(filePath, line, message) {
  return `${filePath}:${line}: ${message}`;
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function validateCiTriggers(lines, filePath, diagnostics) {
  const onEntries = topLevelEntries(lines, "on");
  if (onEntries.length !== 1 || onEntries[0].value !== "") {
    diagnostics.push(
      diagnostic(filePath, onEntries[0]?.index + 1 || 1, "triggers must be exactly pull_request and push"),
    );
    return;
  }

  const onEntry = onEntries[0];
  const end = blockEnd(lines, onEntry.index, 0);
  const events = directKeys(lines, onEntry.index, end, 0);

  for (const event of events) {
    if (UNSAFE_CI_TRIGGERS.has(event.key)) {
      diagnostics.push(
        diagnostic(filePath, event.index + 1, `unsafe trigger ${event.key} is not allowed`),
      );
    } else if (!CI_TRIGGERS.has(event.key)) {
      diagnostics.push(
        diagnostic(filePath, event.index + 1, `trigger ${event.key} is not allowed`),
      );
    }
  }

  if (
    events.length !== 2 ||
    !events.some(({ key }) => key === "push") ||
    !events.some(({ key }) => key === "pull_request")
  ) {
    diagnostics.push(
      diagnostic(filePath, onEntry.index + 1, "triggers must be exactly pull_request and push"),
    );
  }

  const pullRequest = events.find(({ key }) => key === "pull_request");
  if (pullRequest?.value !== "") {
    diagnostics.push(
      diagnostic(filePath, pullRequest.index + 1, "pull_request must not specify activity types"),
    );
  }

  const push = events.find(({ key }) => key === "push");
  if (!push) return;
  if (push.value !== "") {
    diagnostics.push(diagnostic(filePath, push.index + 1, "push branches must be exactly main"));
    return;
  }

  const pushEnd = events
    .filter(({ index }) => index > push.index)
    .reduce((nearest, { index }) => Math.min(nearest, index), end);
  const pushKeys = directKeys(lines, push.index, pushEnd, push.indent);
  const branches = pushKeys.find(({ key }) => key === "branches");
  let branchNames = [];
  if (branches?.value === "") {
    const branchesEnd = Math.min(blockEnd(lines, branches.index, branches.indent), pushEnd);
    branchNames = listValues(lines, branches.index, branchesEnd, branches.indent);
  }

  if (
    pushKeys.length !== 1 ||
    !branches ||
    branchNames.length !== 1 ||
    branchNames[0] !== "main"
  ) {
    diagnostics.push(diagnostic(filePath, push.index + 1, "push branches must be exactly main"));
  }
}

function validatePolicyTriggers(lines, filePath, diagnostics) {
  const onEntries = topLevelEntries(lines, "on");
  if (onEntries.length !== 1 || onEntries[0].value !== "") {
    diagnostics.push(
      diagnostic(filePath, onEntries[0]?.index + 1 || 1, "triggers must be exactly pull_request_target"),
    );
    return;
  }

  const onEntry = onEntries[0];
  const end = blockEnd(lines, onEntry.index, 0);
  const events = directKeys(lines, onEntry.index, end, 0);
  if (
    events.length !== 1 ||
    events[0].key !== "pull_request_target" ||
    events[0].value !== ""
  ) {
    diagnostics.push(
      diagnostic(filePath, onEntry.index + 1, "triggers must be exactly pull_request_target"),
    );
    return;
  }

  const trigger = events[0];
  const triggerEnd = blockEnd(lines, trigger.index, trigger.indent);
  const triggerKeys = directKeys(lines, trigger.index, triggerEnd, trigger.indent);
  const branches = triggerKeys.find(({ key }) => key === "branches");
  const branchNames = branches?.value === ""
    ? listValues(
        lines,
        branches.index,
        Math.min(blockEnd(lines, branches.index, branches.indent), triggerEnd),
        branches.indent,
      )
    : [];
  if (
    triggerKeys.length !== 2 ||
    !branches ||
    branchNames.length !== 1 ||
    branchNames[0] !== "main"
  ) {
    diagnostics.push(
      diagnostic(filePath, trigger.index + 1, "branches must be exactly main"),
    );
  }

  const types = triggerKeys.find(({ key }) => key === "types");
  const activityTypes = types?.value === ""
    ? listValues(
        lines,
        types.index,
        Math.min(blockEnd(lines, types.index, types.indent), triggerEnd),
        types.indent,
      )
    : [];
  if (
    triggerKeys.length !== 2 ||
    !types ||
    activityTypes.length !== POLICY_ACTIVITY_TYPES.length ||
    activityTypes.some((value, index) => value !== POLICY_ACTIVITY_TYPES[index])
  ) {
    diagnostics.push(
      diagnostic(filePath, trigger.index + 1, "activity types must be exactly the trusted pull request activities"),
    );
  }
}

function validatePermissions(lines, filePath, diagnostics) {
  const permissions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = keyValue(lines[index]);
    if (parsed?.key !== "permissions") continue;
    const indent = indentation(lines[index]);
    if (indent === 0) permissions.push({ ...parsed, index, indent });
    else {
      diagnostics.push(diagnostic(filePath, index + 1, "job-level permissions are not allowed"));
    }
  }

  let valid = permissions.length === 1 && permissions[0].value === "";
  if (valid) {
    const permission = permissions[0];
    const end = blockEnd(lines, permission.index, 0);
    const entries = directKeys(lines, permission.index, end, 0);
    valid =
      entries.length === 1 &&
      entries[0].key === "contents" &&
      unquote(entries[0].value) === "read";
  }

  if (!valid) {
    diagnostics.push(
      diagnostic(
        filePath,
        permissions[0]?.index + 1 || 1,
        "permissions must be exactly contents: read",
      ),
    );
  }
}

function usesReference(line) {
  const content = stripComment(line).trim();
  const match = content.match(/^(?:-\s+)?uses\s*:\s*(.+)$/);
  return match ? unquote(match[1].trim()) : null;
}

function stepBounds(lines, usesIndex) {
  const usesIndent = indentation(lines[usesIndex]);
  let start = usesIndex;
  let indent = usesIndent;
  for (let index = usesIndex; index >= 0; index -= 1) {
    const content = stripComment(lines[index]).trim();
    if (content.startsWith("-") && indentation(lines[index]) <= usesIndent) {
      start = index;
      indent = indentation(lines[index]);
      break;
    }
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const content = stripComment(lines[index]).trim();
    if (content.startsWith("-") && indentation(lines[index]) === indent) {
      end = index;
      break;
    }
    if (content && indentation(lines[index]) < indent) {
      end = index;
      break;
    }
  }
  return { start, end, indent };
}

function checkoutInputs(lines, usesIndex) {
  const bounds = stepBounds(lines, usesIndex);
  for (let index = usesIndex + 1; index < bounds.end; index += 1) {
    const parsed = keyValue(lines[index]);
    if (parsed?.key !== "with" || parsed.value !== "") continue;
    const withIndent = indentation(lines[index]);
    const end = Math.min(blockEnd(lines, index, withIndent), bounds.end);
    return directKeys(lines, index, end, withIndent);
  }
  return [];
}

function validateUses(lines, filePath, diagnostics, policyWorkflow) {
  const checkouts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const reference = usesReference(lines[index]);
    if (!reference) continue;
    const local = reference.startsWith("./");
    if (!local && !/@[0-9a-f]{40}$/i.test(reference)) {
      diagnostics.push(
        diagnostic(
          filePath,
          index + 1,
          "non-local uses reference must use a 40-character hexadecimal SHA",
        ),
      );
    }
    if (policyWorkflow && (local || reference.split("@")[0].toLowerCase() !== CHECKOUT_ACTION)) {
      diagnostics.push(diagnostic(filePath, index + 1, "policy may use only the pinned checkout action"));
    }

    if (reference.split("@")[0].toLowerCase() !== CHECKOUT_ACTION) continue;
    checkouts.push(index);
    const inputs = checkoutInputs(lines, index);
    const persistence = inputs.find(({ key }) => key === "persist-credentials");
    if (persistence?.value !== "false") {
      diagnostics.push(
        diagnostic(filePath, index + 1, "actions/checkout must set persist-credentials: false"),
      );
    }
    if (policyWorkflow) {
      const ref = inputs.find(({ key }) => key === "ref");
      if (
        inputs.length !== 2 ||
        unquote(ref?.value || "") !== POLICY_BASE_SHA ||
        persistence?.value !== "false"
      ) {
        diagnostics.push(
          diagnostic(filePath, index + 1, "checkout must use the exact pull request base SHA"),
        );
      }
    }
  }

  if (policyWorkflow && checkouts.length !== 1) {
    diagnostics.push(diagnostic(filePath, 1, "policy must contain exactly one trusted checkout"));
  }
}

function validateSensitiveValues(lines, filePath, diagnostics) {
  const checks = [
    [/\bid-token\s*:\s*["']?write["']?\b/i, "id-token: write is not allowed"],
    [
      /\$\{\{(?:(?!}}).)*\bsecrets\b(?:(?!}}).)*}}/i,
      "secret expressions are not allowed",
    ],
    [
      /\b(?:CLOUDFLARE|CF)_[A-Z0-9_]*(?:TOKEN|KEY|SECRET|ACCOUNT_ID|EMAIL)\b/i,
      "Cloudflare credential names are not allowed",
    ],
    [
      /\bpersist-credentials\s*:\s*["']?true["']?\b/i,
      "persist-credentials: true is not allowed",
    ],
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const content = stripComment(lines[index]);
    for (const [pattern, message] of checks) {
      if (pattern.test(content)) diagnostics.push(diagnostic(filePath, index + 1, message));
    }
  }
}

function findTopLevelBlock(lines, key) {
  const entries = topLevelEntries(lines, key);
  if (entries.length !== 1 || entries[0].value !== "") return null;
  const entry = entries[0];
  return {
    entry,
    end: blockEnd(lines, entry.index, 0),
  };
}

function validatePolicyStructure(lines, filePath, diagnostics) {
  const concurrency = findTopLevelBlock(lines, "concurrency");
  const concurrencyKeys = concurrency
    ? directKeys(lines, concurrency.entry.index, concurrency.end, 0)
    : [];
  if (
    concurrencyKeys.length !== 2 ||
    unquote(concurrencyKeys.find(({ key }) => key === "group")?.value || "") !== POLICY_CONCURRENCY ||
    concurrencyKeys.find(({ key }) => key === "cancel-in-progress")?.value !== "true"
  ) {
    diagnostics.push(diagnostic(filePath, 1, "policy concurrency must be explicit"));
  }

  const jobs = findTopLevelBlock(lines, "jobs");
  const jobEntries = jobs ? directKeys(lines, jobs.entry.index, jobs.end, 0) : [];
  const policyJob = jobEntries[0];
  if (jobEntries.length !== 1 || policyJob?.key !== "policy" || policyJob.value !== "") {
    diagnostics.push(diagnostic(filePath, 1, "policy workflow must contain exactly one policy job"));
    return;
  }

  const jobEnd = blockEnd(lines, policyJob.index, policyJob.indent);
  const jobKeys = directKeys(lines, policyJob.index, jobEnd, policyJob.indent);
  const allowedJobKeys = new Set(["name", "runs-on", "timeout-minutes", "env", "steps"]);
  if (
    jobKeys.some(({ key }) => !allowedJobKeys.has(key)) ||
    unquote(jobKeys.find(({ key }) => key === "name")?.value || "") !== "Policy" ||
    unquote(jobKeys.find(({ key }) => key === "runs-on")?.value || "") !== "ubuntu-latest" ||
    unquote(jobKeys.find(({ key }) => key === "timeout-minutes")?.value || "") !== "5"
  ) {
    diagnostics.push(diagnostic(filePath, policyJob.index + 1, "policy job contract is invalid"));
  }

  const env = jobKeys.find(({ key }) => key === "env");
  const envKeys = env?.value === ""
    ? directKeys(lines, env.index, blockEnd(lines, env.index, env.indent), env.indent)
    : [];
  if (
    envKeys.length !== 2 ||
    envKeys[0].key !== "PR_NUMBER" ||
    unquote(envKeys[0].value) !== POLICY_PR_NUMBER ||
    envKeys[1].key !== "HEAD_SHA" ||
    unquote(envKeys[1].value) !== POLICY_HEAD_SHA
  ) {
    diagnostics.push(diagnostic(filePath, policyJob.index + 1, "policy event sources are invalid"));
  }

  validatePolicyCommands(lines, filePath, diagnostics);
}

function runCommand(lines, index) {
  const parsed = keyValue(lines[index]);
  if (!parsed || parsed.key !== "run") return null;
  if (parsed.value !== "|") return unquote(parsed.value);
  const end = blockEnd(lines, index, indentation(lines[index]));
  return lines
    .slice(index + 1, end)
    .filter((line) => stripComment(line).trim())
    .map((line) => stripComment(line).trim())
    .join("\n");
}

function validatePolicyCommands(lines, filePath, diagnostics) {
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (keyValue(lines[index])?.key === "run") {
      commands.push(runCommand(lines, index));
    }
  }
  const expected = [
    POLICY_INPUT_CHECK,
    POLICY_FETCH,
    POLICY_HEAD_CHECK,
    POLICY_TEST,
    POLICY_CHECK,
  ];
  if (
    commands.length !== expected.length ||
    commands.some((command, index) => command !== expected[index])
  ) {
    diagnostics.push(diagnostic(filePath, 1, "policy steps must use only trusted commands"));
  }
}

export function validateWorkflowText(text, filePath = CI_PATH) {
  const lines = text.split(/\r?\n/);
  const diagnostics = [];
  const policyWorkflow = filePath === POLICY_PATH;
  if (policyWorkflow) validatePolicyTriggers(lines, filePath, diagnostics);
  else validateCiTriggers(lines, filePath, diagnostics);
  validatePermissions(lines, filePath, diagnostics);
  validateSensitiveValues(lines, filePath, diagnostics);
  validateUses(lines, filePath, diagnostics, policyWorkflow);
  if (policyWorkflow) validatePolicyStructure(lines, filePath, diagnostics);
  return diagnostics;
}

export async function validateWorkflowDirectory(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const diagnostics = [];
  const expectedNames = new Set(["ci.yml", "policy.yml"]);
  if (entries.some((entry) => !expectedNames.has(entry.name))) {
    diagnostics.push(
      diagnostic(WORKFLOW_DIRECTORY, 1, "only ci.yml and policy.yml are allowed"),
    );
  }

  for (const [name, filePath] of [
    ["ci.yml", CI_PATH],
    ["policy.yml", POLICY_PATH],
  ]) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry?.isFile()) {
      diagnostics.push(diagnostic(filePath, 1, "required workflow is missing"));
      continue;
    }
    const text = await readFile(path.join(directory, name), "utf8");
    diagnostics.push(...validateWorkflowText(text, filePath));
  }
  return diagnostics;
}

export function isTrustedGitRevision(revision) {
  return (
    revision === "HEAD" ||
    /^[0-9a-f]{40,64}$/i.test(revision) ||
    revision === "refs/remotes/policy/pr-head"
  );
}

async function git(repository, args) {
  return await execFile("git", ["-C", repository, ...args], GIT_OPTIONS);
}

async function resolveRevision(repository, revision) {
  const { stdout } = await git(repository, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  const objectId = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(objectId)) throw new Error("invalid object ID");
  return objectId;
}

export async function validateGitRevision({
  repository = process.cwd(),
  revision,
  baseRevision,
}) {
  if (!isTrustedGitRevision(revision) || !isTrustedGitRevision(baseRevision)) {
    return [GENERIC_REVISION_DIAGNOSTIC];
  }

  try {
    const candidate = await resolveRevision(repository, revision);
    const base = await resolveRevision(repository, baseRevision);
    const diagnostics = [];
    const protectedDiff = await git(repository, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      base,
      candidate,
      "--",
      ...PROTECTED_PATHS,
    ]);
    if (protectedDiff.stdout.length > 0) diagnostics.push(GENERIC_REVISION_DIAGNOSTIC);

    const inventory = await git(repository, [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      candidate,
      "--",
      WORKFLOW_DIRECTORY,
    ]);
    const workflowPaths = inventory.stdout.split("\0").filter(Boolean).sort();
    if (
      workflowPaths.length !== WORKFLOW_PATHS.length ||
      workflowPaths.some((filePath, index) => filePath !== WORKFLOW_PATHS[index])
    ) {
      diagnostics.push(GENERIC_REVISION_DIAGNOSTIC);
    }

    for (const filePath of WORKFLOW_PATHS) {
      const { stdout } = await git(repository, ["show", `${candidate}:${filePath}`]);
      if (validateWorkflowText(stdout, filePath).length > 0) {
        diagnostics.push(GENERIC_REVISION_DIAGNOSTIC);
      }
    }
    return [...new Set(diagnostics)];
  } catch {
    return [GENERIC_REVISION_DIAGNOSTIC];
  }
}

function parseRevisionArguments(args) {
  if (args.length !== 4) return null;
  if (args[0] !== "--revision" || args[2] !== "--base-revision") return null;
  if (!isTrustedGitRevision(args[1]) || !isTrustedGitRevision(args[3])) return null;
  return { revision: args[1], baseRevision: args[3] };
}

async function main() {
  const args = process.argv.slice(2);
  let diagnostics;
  if (args.length === 0) {
    diagnostics = await validateWorkflowDirectory(WORKFLOW_DIRECTORY);
  } else {
    const revisions = parseRevisionArguments(args);
    diagnostics = revisions
      ? await validateGitRevision({ repository: process.cwd(), ...revisions })
      : [GENERIC_REVISION_DIAGNOSTIC];
  }
  if (diagnostics.length === 0) return;
  for (const message of diagnostics) console.error(message);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(GENERIC_REVISION_DIAGNOSTIC);
    process.exitCode = 1;
  }
}
