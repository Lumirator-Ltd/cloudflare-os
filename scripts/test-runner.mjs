import { spawnSync } from "node:child_process";

export function pnpmExecutable(platform = process.platform) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function immutableCommands(commands) {
  return Object.freeze(
    commands.map(({ executable, args }) =>
      Object.freeze({ executable, args: Object.freeze([...args]) }),
    ),
  );
}

export function runCommands(commands, execute = spawnSync) {
  for (const { executable, args } of commands) {
    const result = execute(executable, args, { stdio: "inherit" });

    if (result.error) {
      console.error(result.error);
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }

  return 0;
}
