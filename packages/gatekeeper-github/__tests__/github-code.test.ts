import { describe, expect, it } from "vitest";
import {
  decodeRepoFileText,
  filterTreeEntries,
  parseGitHubResourceUrl,
  prefixTreeEntries,
  splitRepoFullName,
} from "../src/github-code";

describe("parseGitHubResourceUrl", () => {
  it("maps the bare origin to the account resource", () => {
    expect(parseGitHubResourceUrl("https://github.com")).toEqual({ kind: "account" });
    expect(parseGitHubResourceUrl("https://github.com/")).toEqual({ kind: "account" });
  });

  it("maps owner/repo URLs to the repo resource", () => {
    expect(parseGitHubResourceUrl("https://github.com/cloudflare/workerd")).toEqual({
      kind: "repo",
      owner: "cloudflare",
      repo: "workerd",
    });
  });

  it("maps issue URLs to the issue resource", () => {
    expect(parseGitHubResourceUrl("https://github.com/cloudflare/workerd/issues/12")).toEqual({
      kind: "issue",
      owner: "cloudflare",
      repo: "workerd",
      issueNumber: 12,
    });
  });

  it("maps pull request URLs to the pull resource", () => {
    expect(parseGitHubResourceUrl("https://github.com/cloudflare/workerd/pull/7")).toEqual({
      kind: "pull",
      owner: "cloudflare",
      repo: "workerd",
      issueNumber: 7,
    });
  });

  it.each([
    "http://github.com/cloudflare/workerd",
    "https://gitlab.com/cloudflare/workerd",
    "https://GitHub.com/cloudflare/workerd",
    "https://user@github.com/cloudflare/workerd",
    "https://user:pass@github.com/cloudflare/workerd",
    "https://github.com:8443/cloudflare/workerd",
    "https://github.com/cloudflare/workerd?tab=readme",
    "https://github.com/cloudflare/workerd#readme",
    "https://github.com/cloudflare//workerd",
    "https://github.com/cloudflare/workerd/",
    "https://github.com/cloudflare/workerd/tree/main",
    "https://github.com/cloudflare/workerd/issues/abc",
    "https://github.com/cloudflare/workerd/issues/0",
    "https://github.com/cloudflare/workerd/issues/9007199254740992",
    "https://github.com/cloudflare/workerd/issues/12/comments",
    "https://github.com/cloudflare/workerd/pull/-1",
    "https://github.com/cloudflare",
    "https://github.com/-cloudflare/workerd",
    "https://github.com/cloudflare-/workerd",
    "https://github.com/cloudflare/..",
    "https://github.com/cloudflare/bad%20repo",
    `https://github.com/${"a".repeat(40)}/workerd`,
    `https://github.com/cloudflare/${"r".repeat(101)}`,
  ])("rejects non-canonical or unsupported URL %s", url => {
    expect(() => parseGitHubResourceUrl(url)).toThrow("Unsupported GitHub URL");
  });

  it.each([
    "http://github.com",
    "https://github.com?tab=readme",
    "https://github.com/#fragment",
    "https://github.com//",
  ])("rejects non-canonical account URL %s", url => {
    expect(() => parseGitHubResourceUrl(url)).toThrow("Unsupported GitHub URL");
  });
});

describe("splitRepoFullName", () => {
  it("parses exact owner/name identifiers and canonical repository URLs", () => {
    expect(splitRepoFullName("cloudflare/workerd")).toEqual({ owner: "cloudflare", repo: "workerd" });
    expect(splitRepoFullName("https://github.com/cloudflare/workerd")).toEqual({
      owner: "cloudflare",
      repo: "workerd",
    });
  });

  it("preserves a .git suffix instead of silently changing the repository name", () => {
    expect(splitRepoFullName("cloudflare/workerd.git")).toEqual({
      owner: "cloudflare",
      repo: "workerd.git",
    });
    expect(splitRepoFullName("https://github.com/cloudflare/workerd.git")).toEqual({
      owner: "cloudflare",
      repo: "workerd.git",
    });
  });

  it.each([
    " cloudflare/workerd",
    "cloudflare/workerd ",
    " https://github.com/cloudflare/workerd",
    "https://github.com/cloudflare/workerd ",
    "http://github.com/cloudflare/workerd",
    "https://github.com/cloudflare/workerd/",
    "https://github.com/cloudflare/workerd?tab=readme",
    "cloudflare",
    "cloudflare/workerd/extra",
    "https://evil.com/cloudflare/workerd",
    "bad owner/repo",
  ])("rejects non-canonical repository input %j", input => {
    expect(splitRepoFullName(input)).toBeNull();
  });
});

describe("decodeRepoFileText", () => {
  function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
  }

  it("decodes multi-byte UTF-8 text", () => {
    const text = "héllo → 日本語\n";
    const base64 = toBase64(new TextEncoder().encode(text));
    expect(decodeRepoFileText(base64)).toEqual({ text, isBinary: false });
  });

  it("tolerates newline-wrapped base64 as returned by the contents API", () => {
    const base64 = toBase64(new TextEncoder().encode("hello world"));
    const wrapped = `${base64.slice(0, 8)}\n${base64.slice(8)}\n`;
    expect(decodeRepoFileText(wrapped)).toEqual({ text: "hello world", isBinary: false });
  });

  it("flags content containing NUL bytes as binary and omits text", () => {
    const base64 = toBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(decodeRepoFileText(base64)).toEqual({ text: "", isBinary: true });
  });
});

describe("prefixTreeEntries", () => {
  it("prefixes subtree-relative paths with the subtree path", () => {
    expect(prefixTreeEntries([{ path: "a.ts" }, { path: "lib/b.ts" }], "src"))
      .toEqual([{ path: "src/a.ts" }, { path: "src/lib/b.ts" }]);
  });

  it("tolerates trailing slashes and empty paths", () => {
    expect(prefixTreeEntries([{ path: "a.ts" }], "src/")).toEqual([{ path: "src/a.ts" }]);
    expect(prefixTreeEntries([{ path: "a.ts" }], "")).toEqual([{ path: "a.ts" }]);
  });
});

describe("filterTreeEntries", () => {
  const entries = [
    { path: "README.md", type: "file" },
    { path: "src", type: "dir" },
    { path: "src/a.ts", type: "file" },
    { path: "src/lib", type: "dir" },
    { path: "src/lib/b.ts", type: "file" },
  ] as const;

  it("returns everything by default", () => {
    expect(filterTreeEntries(entries)).toEqual([...entries]);
  });

  it("restricts to descendants of a directory, excluding the directory itself", () => {
    expect(filterTreeEntries(entries, "src").map(entry => entry.path)).toEqual([
      "src/a.ts",
      "src/lib",
      "src/lib/b.ts",
    ]);
  });

  it("treats trailing slashes on the path as equivalent", () => {
    expect(filterTreeEntries(entries, "src/")).toEqual(filterTreeEntries(entries, "src"));
  });

  it("lists only direct children when recursive is false", () => {
    expect(filterTreeEntries(entries, "src", false).map(entry => entry.path)).toEqual([
      "src/a.ts",
      "src/lib",
    ]);
    expect(filterTreeEntries(entries, undefined, false).map(entry => entry.path)).toEqual([
      "README.md",
      "src",
    ]);
  });

  it("does not match directories that merely share a prefix", () => {
    const prefixed = [...entries, { path: "src-extra/c.ts", type: "file" } as const];
    expect(filterTreeEntries(prefixed, "src").map(entry => entry.path)).toEqual([
      "src/a.ts",
      "src/lib",
      "src/lib/b.ts",
    ]);
  });
});
