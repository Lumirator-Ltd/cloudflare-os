import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BUILD_COORDINATION_DIR_ENV } from "../src/custom-build.js";

const VITEST = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url).href,
);
const PEER_CONFIG = fileURLToPath(
  new URL("../fixtures/concurrent-vitest.config.ts", import.meta.url).href,
);

function startPeer(peer: "a" | "b", coordinationDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      VITEST,
      "run",
      "--config",
      PEER_CONFIG,
      "--maxWorkers=1",
      "--reporter=dot",
    ], {
      env: {
        ...process.env,
        [BUILD_COORDINATION_DIR_ENV]: coordinationDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", chunk => output += chunk);
    child.stderr.setEncoding("utf8").on("data", chunk => output += chunk);
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`Concurrent harness peer ${peer} exited ${code}:\n${output}`));
    });
  });
}

it("coordinates one build across two independently scheduled harness processes", async () => {
  const coordinationDir = process.env[BUILD_COORDINATION_DIR_ENV];
  if (!coordinationDir) throw new Error(`${BUILD_COORDINATION_DIR_ENV} was not set by global setup`);

  await Promise.all([
    startPeer("a", coordinationDir),
    startPeer("b", coordinationDir),
  ]);

  expect(readFileSync(`${coordinationDir}/builds.txt`, "utf8").trim().split("\n"))
    .toEqual(["build"]);
  expect(existsSync(`${coordinationDir}/harness-started-a`)).toBe(true);
  expect(existsSync(`${coordinationDir}/harness-started-b`)).toBe(true);
});
