import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startTestGatekeeperHarness } from "../src/harness.js";

const BUILD_COUNTER = fileURLToPath(
  new URL("../fixtures/build-counter.mjs", import.meta.url).href,
);
const UPDATE_WORKER = fileURLToPath(
  new URL("../fixtures/harness-update-worker.ts", import.meta.url).href,
);

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe("TestHarness updates", () => {
  it("runs the custom build once while applying repeated runtime config updates", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gadgets-harness-update-"));
    const counter = join(tempDir, "builds.txt");
    const harness = await startTestGatekeeperHarness({
      patchWorkshop(config) {
        config.main = UPDATE_WORKER;
        config.build = {
          ...config.build,
          command: [process.execPath, BUILD_COUNTER, counter].map(shellArg).join(" "),
        };
        config.vars = { VERSION: "initial" };
        delete config.migrations;
      },
    });

    try {
      await expect(harness.server.fetch("/").then(response => response.json()))
        .resolves.toEqual({ version: "initial" });

      for (const version of ["second", "third"]) {
        await harness.updateWorkshop(config => {
          config.vars = { ...config.vars, VERSION: version };
        });
        await expect(harness.server.fetch("/").then(response => response.json()))
          .resolves.toEqual({ version });
      }

      expect(readFileSync(counter, "utf8").trim().split("\n"))
        .toEqual(["build"]);
    } finally {
      await harness.server.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
