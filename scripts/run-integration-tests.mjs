import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["--filter", "@gadgets/workshop-backend", "test:integration"]);
run("pnpm", ["--filter", "@gadgets/integration-tests", "test"]);
