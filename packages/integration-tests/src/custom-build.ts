import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export const BUILD_COORDINATION_DIR_ENV = "GADGETS_INTEGRATION_BUILD_COORDINATION_DIR";

const BUILD_TIMEOUT_ENV = "GADGETS_INTEGRATION_BUILD_TIMEOUT_MS";
const DEFAULT_BUILD_TIMEOUT_MS = 60_000;
const BUILD_TERMINATION_GRACE_MS = 250;
const FOLLOWER_PUBLICATION_GRACE_MS = 5_000;
const BUILD_WAIT_INTERVAL_MS = 20;
// These identify or configure the harness coordinator or Vitest worker, not the build. Remove them
// from both the identity and the child's environment so otherwise-identical workers execute the
// exact same build.
const BUILD_ENV_IGNORED_KEYS = new Set([
  BUILD_COORDINATION_DIR_ENV,
  BUILD_TIMEOUT_ENV,
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

type BuildCoordinationPaths = Readonly<{
  lockPath: string;
  ownerPath: string;
  resultPath: string;
}>;

/** Injectable coordination boundaries used by deterministic race tests. */
export type BuildCoordinationHooks = {
  afterInitialResultRead?: (paths: BuildCoordinationPaths) => void | Promise<void>;
  beforeOwnerLivenessCheck?: (paths: BuildCoordinationPaths) => void | Promise<void>;
};

type ChildOutcome =
  | { type: "error"; error: Error }
  | { type: "close"; code: number | null; signal: NodeJS.Signals | null };

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

function buildTimeoutMs(): number {
  const configured = process.env[BUILD_TIMEOUT_ENV];
  if (configured === undefined) return DEFAULT_BUILD_TIMEOUT_MS;
  const timeout = Number(configured);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(`${BUILD_TIMEOUT_ENV} must be a positive integer`);
  }
  return timeout;
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

function consumeResult(path: string): boolean {
  const result = readResult(path);
  if (result?.status === "success") return true;
  if (result?.status === "failure") throw new Error(result.message);
  return false;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx");
    writeFileSync(descriptor, JSON.stringify(value));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the publication error; lock cleanup below removes any incomplete temporary file.
      }
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

function writeResult(path: string, result: BuildResult): void {
  writeJsonAtomic(path, result);
}

function ownerMetadataIsTransient(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError;
}

function builderIsAlive(ownerPath: string, lockPath: string): boolean | undefined {
  let owner: unknown;
  try {
    owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch (error) {
    if (ownerMetadataIsTransient(error)) return existsSync(lockPath) ? undefined : false;
    throw error;
  }

  const pid = typeof owner === "object" && owner !== null && "pid" in owner
    ? (owner as { pid?: unknown }).pid
    : undefined;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    return existsSync(lockPath) ? undefined : false;
  }

  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForBuild(
    paths: BuildCoordinationPaths,
    description: string,
    timeoutMs: number,
    hooks?: BuildCoordinationHooks,
): Promise<void> {
  const deadline = Date.now() + timeoutMs + BUILD_TERMINATION_GRACE_MS
    + FOLLOWER_PUBLICATION_GRACE_MS;
  while (Date.now() < deadline) {
    if (consumeResult(paths.resultPath)) return;

    await hooks?.beforeOwnerLivenessCheck?.(paths);
    if (builderIsAlive(paths.ownerPath, paths.lockPath) === false) {
      // Result publication and lock removal are separate operations. The owner may have completed
      // between this follower's result read and liveness check.
      if (consumeResult(paths.resultPath)) return;
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

function childOutcome(child: ChildProcess): Promise<ChildOutcome> {
  return new Promise(resolveOutcome => {
    child.once("error", error => resolveOutcome({ type: "error", error }));
    child.once("close", (code, signal) => resolveOutcome({ type: "close", code, signal }));
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function runTaskkill(pid: number): Promise<void> {
  const taskkill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await childOutcome(taskkill);
}

async function terminateProcessTree(
    child: ChildProcess, outcome: Promise<ChildOutcome>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    await outcome;
    return;
  }

  if (process.platform === "win32") {
    await runTaskkill(pid);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await outcome;
    return;
  }

  signalProcessGroup(pid, "SIGTERM");
  await Promise.race([outcome, sleep(BUILD_TERMINATION_GRACE_MS)]);
  // The elected child may have exited while a descendant ignored SIGTERM. Kill the group even when
  // the direct child has already closed so no build descendant survives the timeout.
  signalProcessGroup(pid, "SIGKILL");
  await outcome;
}

async function executeChild(
    child: ChildProcess, description: string, timeoutMs: number): Promise<void> {
  const outcome = childOutcome(child);
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">(resolveDeadline => {
    timeout = setTimeout(() => resolveDeadline("timeout"), timeoutMs);
  });
  const completed = await Promise.race([outcome, deadline]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (completed === "timeout") {
    await terminateProcessTree(child, outcome);
    throw new Error(`Timed out after ${timeoutMs}ms`);
  }
  if (completed.type === "error") throw completed.error;
  if (completed.code === 0) return;
  const ending = completed.code === null
    ? `signal ${completed.signal ?? "unknown"}`
    : `exit code ${completed.code}`;
  throw new Error(`Build process ended with ${ending}: ${description}`);
}

async function coordinateBuild(
    build: CustomBuild,
    execute: (cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>,
    hooks?: BuildCoordinationHooks,
): Promise<void> {
  const command = build.command;
  if (!command) return;

  const cwd = resolve(build.cwd ?? process.cwd());
  const env = buildEnvironment();
  const timeoutMs = buildTimeoutMs();
  const coordinationDir = process.env[BUILD_COORDINATION_DIR_ENV];
  if (!coordinationDir) {
    await execute(cwd, env, timeoutMs);
    return;
  }

  const identity = buildIdentity(build, cwd, env);
  const lockPath = resolve(coordinationDir, `${identity}.lock`);
  const ownerPath = resolve(lockPath, "owner.json");
  const resultPath = resolve(coordinationDir, `${identity}.result.json`);
  const paths = { lockPath, ownerPath, resultPath };
  const description = `${command} in ${cwd}`;

  if (consumeResult(resultPath)) return;
  await hooks?.afterInitialResultRead?.(paths);

  // mkdir is the cross-process election: exactly one worker can create this identity's lock.
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await waitForBuild(paths, description, timeoutMs, hooks);
    return;
  }

  try {
    // A previous builder may publish and release its lock after this contender's initial read but
    // before election. Recheck after election so this new lock cannot authorize a duplicate build.
    if (consumeResult(resultPath)) return;

    try {
      writeJsonAtomic(ownerPath, { pid: process.pid });
      await execute(cwd, env, timeoutMs);
      // Atomic result publication is the fence: peers cannot proceed while output is still changing.
      writeResult(resultPath, { status: "success" });
    } catch (error) {
      const message = failureMessage(error, description);
      try {
        writeResult(resultPath, { status: "failure", message });
      } catch {
        // The original failure is more actionable. Peers observe lock removal and fail boundedly when
        // the filesystem also prevents publishing the shared result.
      }
      throw new Error(message, { cause: error });
    }
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function runCustomBuildOnce(
    build: CustomBuild, hooks?: BuildCoordinationHooks): Promise<void> {
  const command = build.command;
  if (!command) return Promise.resolve();
  return coordinateBuild(build, async (cwd, env, timeoutMs) => {
    const child = spawn(command, {
      cwd,
      detached: process.platform !== "win32",
      env,
      shell: true,
      stdio: "inherit",
      windowsHide: true,
    });
    await executeChild(child, command, timeoutMs);
  }, hooks);
}

export function runFileBuildOnce(file: string, args: string[], cwd: string): Promise<void> {
  const description = JSON.stringify([file, ...args]);
  return coordinateBuild({
    command: description,
    cwd,
    invocation: "execFile",
  }, async (resolvedCwd, env, timeoutMs) => {
    const child = spawn(file, args, {
      cwd: resolvedCwd,
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    await executeChild(child, description, timeoutMs);
  });
}
