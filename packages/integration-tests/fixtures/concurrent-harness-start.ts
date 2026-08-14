import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_COORDINATION_DIR_ENV } from "../src/custom-build.js";
import { startTestGatekeeperHarness } from "../src/harness.js";

const CONCURRENT_BUILD = fileURLToPath(
  new URL("./concurrent-build.mjs", import.meta.url).href,
);

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export async function runConcurrentHarnessStartup(peer: "a" | "b"): Promise<void> {
  const dir = process.env[BUILD_COORDINATION_DIR_ENV];
  if (!dir) throw new Error(`${BUILD_COORDINATION_DIR_ENV} was not set by Vitest global setup`);

  closeSync(openSync(join(dir, `ready-${peer}`), "w"));
  await waitFor(join(dir, peer === "a" ? "ready-b" : "ready-a"));

  const generatedWorker = join(dir, "generated-worker.ts");
  const command = [process.execPath, CONCURRENT_BUILD, dir].map(shellArg).join(" ");
  const harness = await startTestGatekeeperHarness({
    patchWorkshop(config) {
      config.main = generatedWorker;
      config.build = { ...config.build, command };
      config.vars = {};
      delete config.migrations;
    },
  });

  try {
    const response = await harness.server.fetch("/").then(result => result.json());
    if (JSON.stringify(response) !== JSON.stringify({ ready: true })) {
      throw new Error(`Harness ${peer} returned an unexpected response: ${JSON.stringify(response)}`);
    }
    const builds = readFileSync(join(dir, "builds.txt"), "utf8").trim().split("\n");
    if (builds.length !== 1 || builds[0] !== "build") {
      throw new Error(`Expected one shared build, found ${builds.length}`);
    }
    closeSync(openSync(join(dir, `harness-started-${peer}`), "w"));
  } finally {
    await harness.server.close();
  }
}
