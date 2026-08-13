import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  immutableCommands,
  pnpmExecutable,
  runCommands,
} from "./test-runner.mjs";

function rootTestFiles() {
  return readdirSync(new URL(".", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => `scripts/${entry.name}`)
    .toSorted();
}

export function unitTestCommands(platform = process.platform) {
  const pnpm = pnpmExecutable(platform);

  return immutableCommands([
    {
      executable: process.execPath,
      args: ["--test", ...rootTestFiles()],
    },
    {
      executable: pnpm,
      args: [
        "--filter",
        "!@gadgets/integration-tests",
        "--filter",
        "!@gadgets/workshop-backend",
        "--recursive",
        "--if-present",
        "test",
      ],
    },
    {
      executable: pnpm,
      args: ["--filter", "@gadgets/workshop-backend", "test:unit"],
    },
  ]);
}

export function main(execute = spawnSync, platform = process.platform) {
  return runCommands(unitTestCommands(platform), execute);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
