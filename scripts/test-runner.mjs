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

export function runCommands(
  commands,
  execute = spawnSync,
  platform = process.platform,
) {
  for (const { executable, args } of commands) {
    let spawnExecutable = executable;
    let spawnArgs = args;

    if (platform === "win32" && executable === "pnpm.cmd") {
      spawnExecutable = "cmd.exe";
      // This /c payload contains only runner-owned static arguments. Do not pass
      // untrusted values here because cmd.exe interprets shell metacharacters.
      spawnArgs = ["/d", "/s", "/c", executable, ...args];
    }

    const result = execute(spawnExecutable, spawnArgs, { stdio: "inherit" });

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
