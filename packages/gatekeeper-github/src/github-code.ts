// Pure helpers for the GitHub code-read surface. This module must stay free of
// `cloudflare:workers` imports so it can be unit tested under the plain node vitest
// environment.

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

// NUL-byte sniffing window for binary detection, matching git's own heuristic.
const BINARY_SNIFF_BYTES = 8192;

export type ParsedGitHubResourceUrl =
  | { kind: "account" }
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "issue"; owner: string; repo: string; issueNumber: number }
  | { kind: "pull"; owner: string; repo: string; issueNumber: number };

/**
 * Classifies a github.com URL into one of the supported resource kinds. The bare origin is
 * the account-wide resource; owner-only URLs are rejected; URLs with extra or non-numeric
 * trailing segments fall back to the enclosing repository.
 */
export function parseGitHubResourceUrl(url: string): ParsedGitHubResourceUrl {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") {
    throw new Error(`Unsupported GitHub URL: ${url}`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return { kind: "account" };
  }
  if (segments.length < 2) {
    throw new Error(`Unsupported GitHub URL: ${url}`);
  }

  const [owner, repo, kind, number] = segments;
  if (kind === "issues" && number && /^\d+$/.test(number)) {
    return { kind: "issue", owner, repo, issueNumber: Number(number) };
  }
  if (kind === "pull" && number && /^\d+$/.test(number)) {
    return { kind: "pull", owner, repo, issueNumber: Number(number) };
  }
  return { kind: "repo", owner, repo };
}

/**
 * Parses an "owner/name" pair or a github.com repository URL. Returns null when the input
 * does not name exactly one repository.
 */
export function splitRepoFullName(input: string): { owner: string; repo: string } | null {
  let fullName = input.trim();

  if (/^https?:\/\//i.test(fullName)) {
    try {
      const url = new URL(fullName);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      fullName = url.pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return null;
    }
  }

  const [owner, rawRepo, ...rest] = fullName.split("/");
  if (!owner || !rawRepo || rest.length > 0) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) return null;
  return { owner, repo };
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
