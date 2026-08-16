#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const ALLOWED_TRIGGERS = new Set(["pull_request", "push"]);
const UNSAFE_TRIGGERS = new Set([
  "pull_request_target",
  "issue_comment",
  "issues",
  "workflow_run",
  "schedule",
]);

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
    if (parsed && indent > parentIndent) candidates.push({ ...parsed, index, indent });
  }
  if (candidates.length === 0) return [];
  const directIndent = Math.min(...candidates.map(({ indent }) => indent));
  return candidates.filter(({ indent }) => indent === directIndent);
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

function validateTriggers(lines, filePath, diagnostics) {
  const onEntries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = keyValue(lines[index]);
    if (parsed?.key === "on" && indentation(lines[index]) === 0) {
      onEntries.push({ ...parsed, index });
    }
  }

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
    if (UNSAFE_TRIGGERS.has(event.key)) {
      diagnostics.push(
        diagnostic(filePath, event.index + 1, `unsafe trigger ${event.key} is not allowed`),
      );
    } else if (!ALLOWED_TRIGGERS.has(event.key)) {
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

  const push = events.find(({ key }) => key === "push");
  if (!push) return;
  if (push.value !== "") {
    diagnostics.push(
      diagnostic(filePath, push.index + 1, "push branches must be exactly main"),
    );
    return;
  }
  const pushEnd = events
    .filter(({ index }) => index > push.index)
    .reduce((nearest, { index }) => Math.min(nearest, index), end);
  const pushKeys = directKeys(lines, push.index, pushEnd, push.indent);
  const branches = pushKeys.find(({ key }) => key === "branches");
  let branchNames = [];

  if (branches && branches.value === "") {
    const branchesEnd = blockEnd(lines, branches.index, branches.indent);
    branchNames = lines
      .slice(branches.index + 1, Math.min(branchesEnd, pushEnd))
      .map((line) => stripComment(line).trim().match(/^-\s+(.+)$/)?.[1])
      .filter(Boolean)
      .map(unquote);
  }

  if (
    pushKeys.length !== 1 ||
    !branches ||
    branchNames.length !== 1 ||
    branchNames[0] !== "main"
  ) {
    diagnostics.push(
      diagnostic(filePath, push.index + 1, "push branches must be exactly main"),
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
      diagnostics.push(
        diagnostic(filePath, index + 1, "job-level permissions are not allowed"),
      );
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

function checkoutDisablesCredentials(lines, usesIndex) {
  const usesIndent = indentation(lines[usesIndex]);
  let stepStart = usesIndex;
  let stepIndent = usesIndent;

  for (let index = usesIndex; index >= 0; index -= 1) {
    const content = stripComment(lines[index]).trim();
    if (content.startsWith("-") && indentation(lines[index]) <= usesIndent) {
      stepStart = index;
      stepIndent = indentation(lines[index]);
      break;
    }
  }

  let stepEnd = lines.length;
  for (let index = stepStart + 1; index < lines.length; index += 1) {
    const content = stripComment(lines[index]).trim();
    if (content.startsWith("-") && indentation(lines[index]) === stepIndent) {
      stepEnd = index;
      break;
    }
    if (content && indentation(lines[index]) < stepIndent) {
      stepEnd = index;
      break;
    }
  }

  for (let index = usesIndex + 1; index < stepEnd; index += 1) {
    const parsed = keyValue(lines[index]);
    if (parsed?.key !== "with" || parsed.value !== "") continue;
    const withIndent = indentation(lines[index]);
    const withEnd = blockEnd(lines, index, withIndent);
    for (let child = index + 1; child < Math.min(withEnd, stepEnd); child += 1) {
      const input = keyValue(lines[child]);
      if (
        input?.key === "persist-credentials" &&
        input.value === "false" &&
        indentation(lines[child]) > withIndent
      ) {
        return true;
      }
    }
  }

  return false;
}

function validateUses(lines, filePath, diagnostics) {
  for (let index = 0; index < lines.length; index += 1) {
    const reference = usesReference(lines[index]);
    if (!reference) continue;

    if (!reference.startsWith("./") && !/@[0-9a-f]{40}$/i.test(reference)) {
      diagnostics.push(
        diagnostic(
          filePath,
          index + 1,
          "non-local uses reference must use a 40-character hexadecimal SHA",
        ),
      );
    }

    if (
      reference.split("@")[0].toLowerCase() === "actions/checkout" &&
      !checkoutDisablesCredentials(lines, index)
    ) {
      diagnostics.push(
        diagnostic(
          filePath,
          index + 1,
          "actions/checkout must set persist-credentials: false",
        ),
      );
    }
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
      if (pattern.test(content)) {
        diagnostics.push(diagnostic(filePath, index + 1, message));
      }
    }
  }
}

export function validateWorkflowText(text, filePath = WORKFLOW_PATH) {
  const lines = text.split(/\r?\n/);
  const diagnostics = [];
  validateTriggers(lines, filePath, diagnostics);
  validatePermissions(lines, filePath, diagnostics);
  validateSensitiveValues(lines, filePath, diagnostics);
  validateUses(lines, filePath, diagnostics);
  return diagnostics;
}

export async function validateWorkflowDirectory(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const diagnostics = [];
  const ciEntry = entries.find(({ name }) => name === "ci.yml");

  for (const entry of entries) {
    if (entry.name !== "ci.yml") {
      diagnostics.push(
        diagnostic(
          `.github/workflows/${entry.name}`,
          1,
          "only .github/workflows/ci.yml is allowed",
        ),
      );
    }
  }

  if (!ciEntry?.isFile()) {
    diagnostics.push(diagnostic(WORKFLOW_PATH, 1, "required workflow is missing"));
    return diagnostics;
  }

  const text = await readFile(path.join(directory, "ci.yml"), "utf8");
  diagnostics.push(...validateWorkflowText(text));
  return diagnostics;
}

async function main() {
  const directory = process.argv[2] || ".github/workflows";
  const diagnostics = await validateWorkflowDirectory(directory);
  if (diagnostics.length === 0) return;
  for (const message of diagnostics) console.error(message);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
