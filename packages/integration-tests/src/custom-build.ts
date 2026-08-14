import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export const BUILD_COORDINATION_DIR_ENV = "GADGETS_INTEGRATION_BUILD_COORDINATION_DIR";

const BUILD_WAIT_TIMEOUT_MS = 60_000;
const BUILD_WAIT_INTERVAL_MS = 20;
// These identify the harness coordinator or Vitest worker, not the build. Remove them from both the
// identity and the child's environment so otherwise-identical workers execute the exact same build.
const BUILD_ENV_IGNORED_KEYS = new Set([
  BUILD_COORDINATION_DIR_ENV,
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
]);

type CustomBuild = Record<string, unknown> & {
  command?: string;
  cwd?: string;
};

type BuildResult =
  | { status: "success" }
  | { status: "failure"; message: string };

function sortedEntries<T>(value: Record<string, T>): [string, T][] {
  const entries = Object.entries(value) as [string, T][] & {
    toSorted(compare: (left: [string, T], right: [string, T]) => number): [string, T][];
  };
  return entries.toSorted(([left], [right]) => left.localeCompare(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(sortedEntries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function buildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(sortedEntries(process.env)
    .filter(([key, value]) => value !== undefined && !BUILD_ENV_IGNORED_KEYS.has(key)));
}

function buildIdentity(build: CustomBuild, cwd: string, env: NodeJS.ProcessEnv): string {
  const invocation = canonicalize({
    build: { ...build, cwd },
    command: build.command,
    cwd,
    env,
  });
  return createHash("sha256").update(JSON.stringify(invocation)).digest("hex");
}

function readResult(path: string): BuildResult | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BuildResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeResult(path: string, result: BuildResult): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(result));
  renameSync(temporary, path);
}

function builderIsAlive(path: string): boolean | undefined {
  let owner: { pid: number };
  try {
    owner = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForBuild(
    resultPath: string, ownerPath: string, description: string): Promise<void> {
  const deadline = Date.now() + BUILD_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = readResult(resultPath);
    if (result?.status === "success") return;
    if (result?.status === "failure") throw new Error(result.message);

    if (builderIsAlive(ownerPath) === false) {
      throw new Error(`Custom build process exited before reporting completion: ${description}`);
    }
    await new Promise(complete => setTimeout(complete, BUILD_WAIT_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for custom build: ${description}`);
}

function failureMessage(error: unknown, description: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Custom build failed (${description}): ${detail}`;
}

async function coordinateBuild(
    build: CustomBuild,
    execute: (cwd: string, env: NodeJS.ProcessEnv) => void,
): Promise<void> {
  const command = build.command;
  if (!command) return;

  const cwd = resolve(build.cwd ?? process.cwd());
  const env = buildEnvironment();
  const coordinationDir = process.env[BUILD_COORDINATION_DIR_ENV];
  if (!coordinationDir) {
    execute(cwd, env);
    return;
  }

  const identity = buildIdentity(build, cwd, env);
  const lockPath = resolve(coordinationDir, `${identity}.lock`);
  const ownerPath = resolve(lockPath, "owner.json");
  const resultPath = resolve(coordinationDir, `${identity}.result.json`);
  const description = `${command} in ${cwd}`;

  const priorResult = readResult(resultPath);
  if (priorResult?.status === "success") return;
  if (priorResult?.status === "failure") throw new Error(priorResult.message);

  // mkdir is the cross-process election: exactly one worker can create this identity's lock.
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await waitForBuild(resultPath, ownerPath, description);
    return;
  }

  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }));
  try {
    execute(cwd, env);
    // Atomic result publication is the fence: peers cannot proceed while output is still changing.
    writeResult(resultPath, { status: "success" });
  } catch (error) {
    const message = failureMessage(error, description);
    writeResult(resultPath, { status: "failure", message });
    throw new Error(message, { cause: error });
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function runCustomBuildOnce(build: CustomBuild): Promise<void> {
  const command = build.command;
  if (!command) return Promise.resolve();
  return coordinateBuild(build, (cwd, env) => {
    execSync(command, { cwd, env, stdio: "inherit" });
  });
}

export function runFileBuildOnce(file: string, args: string[], cwd: string): Promise<void> {
  return coordinateBuild({
    command: JSON.stringify([file, ...args]),
    cwd,
    invocation: "execFile",
  }, (resolvedCwd, env) => {
    execFileSync(file, args, { cwd: resolvedCwd, env, stdio: "inherit" });
  });
}
