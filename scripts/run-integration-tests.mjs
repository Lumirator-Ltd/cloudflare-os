import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  immutableCommands,
  pnpmExecutable,
  runCommands,
} from "./test-runner.mjs";

export function integrationTestCommands(platform = process.platform) {
  const pnpm = pnpmExecutable(platform);

  return immutableCommands([
    {
      executable: pnpm,
      args: ["--filter", "@gadgets/workshop-backend", "test:integration"],
    },
    {
      executable: pnpm,
      args: ["--filter", "@gadgets/integration-tests", "test"],
    },
  ]);
}

export function main(execute = spawnSync, platform = process.platform) {
  return runCommands(integrationTestCommands(platform), execute, platform);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
