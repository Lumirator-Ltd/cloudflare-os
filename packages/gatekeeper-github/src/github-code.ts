import type { GitHubPullFileResponse } from "./github-api";
import { parseCanonicalGitHubRepository } from "./github-account-reads";
import type { GitHubPullRequestDiffFile, GitHubPullRequestDiffHunk } from "./types";

// Pure helpers for the GitHub code-read surface. This module must stay free of
// `cloudflare:workers` imports so it can be unit tested under the plain node vitest
// environment.

// NUL-byte sniffing window for binary detection, matching git's own heuristic.
const BINARY_SNIFF_BYTES = 8192;

export type ParsedGitHubResourceUrl =
  | { kind: "account" }
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "issue"; owner: string; repo: string; issueNumber: number }
  | { kind: "pull"; owner: string; repo: string; issueNumber: number };

/** Classifies an exact canonical `https://github.com` account or resource URL. */
export function parseGitHubResourceUrl(url: string): ParsedGitHubResourceUrl {
  const unsupported = (): never => {
    throw new Error(`Unsupported GitHub URL: ${url}`);
  };
  if (url === "https://github.com" || url === "https://github.com/") {
    return { kind: "account" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return unsupported();
  }
  if (parsed.origin !== "https://github.com"
      || parsed.username !== "" || parsed.password !== ""
      || parsed.search !== "" || parsed.hash !== "") {
    return unsupported();
  }

  const segments = parsed.pathname.split("/");
  if (segments[0] !== "" || (segments.length !== 3 && segments.length !== 5)) {
    return unsupported();
  }

  const owner = segments[1];
  const repo = segments[2];
  try {
    parseCanonicalGitHubRepository(`${owner}/${repo}`);
  } catch {
    return unsupported();
  }

  if (segments.length === 3) {
    if (url !== `https://github.com/${owner}/${repo}`) return unsupported();
    return { kind: "repo", owner, repo };
  }

  const pathKind = segments[3];
  const rawNumber = segments[4];
  if ((pathKind !== "issues" && pathKind !== "pull") || !/^[1-9]\d*$/.test(rawNumber)) {
    return unsupported();
  }
  const issueNumber = Number(rawNumber);
  if (!Number.isSafeInteger(issueNumber)
      || url !== `https://github.com/${owner}/${repo}/${pathKind}/${issueNumber}`) {
    return unsupported();
  }
  return pathKind === "issues"
    ? { kind: "issue", owner, repo, issueNumber }
    : { kind: "pull", owner, repo, issueNumber };
}

/**
 * Parses an "owner/name" pair or a github.com repository URL. Returns null when the input
 * does not name exactly one repository.
 */
export function splitRepoFullName(input: string): { owner: string; repo: string } | null {
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = parseGitHubResourceUrl(input);
      return parsed.kind === "repo" ? { owner: parsed.owner, repo: parsed.repo } : null;
    } catch {
      return null;
    }
  }

  try {
    return parseCanonicalGitHubRepository(input);
  } catch {
    return null;
  }
}

/**
 * Decodes a base64-encoded repository file (as returned by the contents API, which wraps
 * base64 in newlines) into UTF-8 text. Files containing NUL bytes in their leading window
 * are reported as binary with empty text rather than decoded to garbage.
 */
export function decodeRepoFileText(base64: string): { text: string; isBinary: boolean } {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const sniffLimit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLimit; i++) {
    if (bytes[i] === 0) {
      return { text: "", isBinary: true };
    }
  }

  return { text: new TextDecoder("utf-8").decode(bytes), isBinary: false };
}

/**
 * Prefixes subtree-relative entry paths with the subtree's own path, so entries fetched
 * from a subtree object line up with entries of a root-level recursive listing.
 */
export function prefixTreeEntries<T extends { path: string }>(entries: readonly T[], path: string): T[] {
  const normalizedPath = path.replace(/\/+$/, "");
  if (normalizedPath.length === 0) return [...entries];
  return entries.map(entry => ({ ...entry, path: `${normalizedPath}/${entry.path}` }));
}

/**
 * Filters a recursive tree listing down to the requested directory. The directory entry
 * itself is excluded; with `recursive` false only direct children remain. Paths are
 * compared segment-wise, so "src" never matches "src-extra".
 */
export function filterTreeEntries<T extends { path: string }>(
  entries: readonly T[],
  path?: string,
  recursive = true,
): T[] {
  const normalizedPath = path?.replace(/\/+$/, "") ?? "";
  const prefix = normalizedPath.length > 0 ? `${normalizedPath}/` : "";

  return entries.filter(entry => {
    if (!entry.path.startsWith(prefix) || entry.path === normalizedPath) return false;
    if (!recursive && entry.path.slice(prefix.length).includes("/")) return false;
    return true;
  });
}

function parsePatch(patch: string): GitHubPullRequestDiffHunk[] {
  const lines = patch.split("\n");
  const hunks: GitHubPullRequestDiffHunk[] = [];
  let currentHunk: GitHubPullRequestDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ kind: "added", text: line.slice(1), newLineNumber: newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ kind: "removed", text: line.slice(1), oldLineNumber: oldLine });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      currentHunk.lines.push({ kind: "context", text: line });
    } else {
      currentHunk.lines.push({
        kind: "context",
        text: line.startsWith(" ") ? line.slice(1) : line,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return hunks;
}

/** Converts one GitHub changed-file response to the public diff-file shape. */
export function normalizeGitHubPullRequestDiffFile(
  file: GitHubPullFileResponse,
): GitHubPullRequestDiffFile {
  return {
    path: file.filename,
    previousPath: file.previous_filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    diffOmitted: !file.patch,
    hunks: file.patch ? parsePatch(file.patch) : [],
  };
}
