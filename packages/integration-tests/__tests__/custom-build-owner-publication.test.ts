import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(source: string, destination: string) {
      if (destination.endsWith("owner.json")) {
        const error = new Error("simulated owner publication failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return actual.renameSync(source, destination);
    },
  };
});

const { BUILD_COORDINATION_DIR_ENV, runCustomBuildOnce } = await import("../src/custom-build.js");
const tempDirs: string[] = [];

afterEach(() => {
  delete process.env[BUILD_COORDINATION_DIR_ENV];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("publishes owner metadata atomically and releases election after publication fails", async () => {
  const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-owner-publication-"));
  tempDirs.push(coordinationDir);
  process.env[BUILD_COORDINATION_DIR_ENV] = coordinationDir;

  await expect(runCustomBuildOnce({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("")}`,
    cwd: coordinationDir,
  })).rejects.toThrow("simulated owner publication failure");

  const entries = readdirSync(coordinationDir);
  expect(entries.some(entry => entry.endsWith(".lock"))).toBe(false);
  const resultName = entries.find(entry => entry.endsWith(".result.json"));
  expect(resultName).toBeDefined();
  expect(JSON.parse(readFileSync(join(coordinationDir, resultName!), "utf8"))).toMatchObject({
    status: "failure",
    message: expect.stringContaining("simulated owner publication failure"),
  });
});
