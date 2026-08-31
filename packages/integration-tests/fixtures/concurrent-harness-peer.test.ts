import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { BUILD_COORDINATION_DIR_ENV } from "../src/custom-build.js";
import { runConcurrentHarnessStartup } from "./concurrent-harness-start.js";

function claimPeer(): "a" | "b" {
  const coordinationDir = process.env[BUILD_COORDINATION_DIR_ENV];
  if (!coordinationDir) throw new Error(`${BUILD_COORDINATION_DIR_ENV} was not set`);
  try {
    closeSync(openSync(join(coordinationDir, "peer-a-claimed"), "wx"));
    return "a";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "b";
    throw error;
  }
}

it("starts its harness after the shared build completes", async () => {
  await runConcurrentHarnessStartup(claimPeer());
});
