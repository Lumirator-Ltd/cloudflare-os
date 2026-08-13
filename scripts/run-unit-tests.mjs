import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("node", ["--test", "scripts/*.test.js"], { shell: true });
run("pnpm", [
  "--filter",
  "!@gadgets/integration-tests",
  "--filter",
  "!@gadgets/workshop-backend",
  "--recursive",
  "--if-present",
  "test",
]);
run("pnpm", ["--filter", "@gadgets/workshop-backend", "test:unit"]);
