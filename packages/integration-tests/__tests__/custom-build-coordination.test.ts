import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  BUILD_COORDINATION_DIR_ENV,
  runCustomBuildOnce,
} from "../src/custom-build.js";

const RUNNER = fileURLToPath(
  new URL("../fixtures/custom-build-runner.mjs", import.meta.url).href,
);
const HANGING_BUILD = fileURLToPath(
  new URL("../fixtures/hanging-build.mjs", import.meta.url).href,
);
const BLOCKING_BUILD = fileURLToPath(
  new URL("../fixtures/blocking-build.mjs", import.meta.url).href,
);
const SUCCESSFUL_BUILD = fileURLToPath(
  new URL("../fixtures/successful-build.mjs", import.meta.url).href,
);
const tempDirs: string[] = [];
const activeChildren = new Set<ChildProcess>();
const originalCoordinationDir = process.env[BUILD_COORDINATION_DIR_ENV];
const originalNodeOptions = process.env.NODE_OPTIONS;
const canDisableTypeStripping = spawnSync(process.execPath, ["-e", ""], {
  env: { ...process.env, NODE_OPTIONS: "--no-experimental-strip-types" },
  stdio: "ignore",
}).status === 0;

type RunnerResult = { code: number | null; output: string };
type Runner = { child: ChildProcess; completion: Promise<RunnerResult> };

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function command(file: string, ...args: string[]): string {
  return [process.execPath, file, ...args].map(shellArg).join(" ");
}

function startRunner(
    coordinationDir: string, timeoutMs: number, cwd: string, buildCommand: string): Runner {
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--no-warnings",
    RUNNER,
    coordinationDir,
    String(timeoutMs),
    cwd,
    buildCommand,
  ], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  let output = "";
  child.stdout!.setEncoding("utf8").on("data", chunk => output += chunk);
  child.stderr!.setEncoding("utf8").on("data", chunk => output += chunk);
  const completion = new Promise<RunnerResult>((resolve, reject) => {
    const hardDeadline = setTimeout(() => {
      terminateTestProcess(child);
      reject(new Error(`Custom build runner exceeded test deadline:\n${output}`));
    }, 5_000);
    child.on("error", error => {
      clearTimeout(hardDeadline);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(hardDeadline);
      activeChildren.delete(child);
      resolve({ code, output: output.trim() });
    });
  });
  return { child, completion };
}

function terminateTestProcess(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForRunnerReadiness(
    runner: Runner, predicate: () => boolean, description: string): Promise<void> {
  while (!predicate()) {
    const result = await Promise.race([
      runner.completion,
      new Promise<undefined>(resolve => setTimeout(resolve, 10)),
    ]);
    if (result !== undefined) {
      throw new Error([
        `Custom build runner exited before ${description} (code ${String(result.code)}):`,
        result.output,
      ].join("\n"));
    }
  }
}

async function waitForProcessExit(pid: number, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

afterEach(() => {
  for (const child of activeChildren) terminateTestProcess(child);
  activeChildren.clear();
  if (originalCoordinationDir === undefined) delete process.env[BUILD_COORDINATION_DIR_ENV];
  else process.env[BUILD_COORDINATION_DIR_ENV] = originalCoordinationDir;
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("consumes a result published after its initial read instead of rebuilding after election", async () => {
  const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-build-election-recheck-"));
  tempDirs.push(coordinationDir);
  process.env[BUILD_COORDINATION_DIR_ENV] = coordinationDir;
  const output = join(coordinationDir, "unexpected-build.txt");

  await runCustomBuildOnce({
    command: command(SUCCESSFUL_BUILD, output),
    cwd: coordinationDir,
  }, {
    afterInitialResultRead({ resultPath }) {
      // The first builder atomically published this result and removed its lock while this contender
      // was paused immediately before election.
      writeFileSync(resultPath, JSON.stringify({ status: "success" }));
    },
  });

  expect(existsSync(output)).toBe(false);
  expect(readdirSync(coordinationDir).some(entry => entry.endsWith(".lock"))).toBe(false);
});

it("consumes a result published after its follower read before reporting a missing owner", async () => {
  const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-build-dead-owner-recheck-"));
  tempDirs.push(coordinationDir);
  process.env[BUILD_COORDINATION_DIR_ENV] = coordinationDir;
  const output = join(coordinationDir, "unexpected-build.txt");

  await runCustomBuildOnce({
    command: command(SUCCESSFUL_BUILD, output),
    cwd: coordinationDir,
  }, {
    afterInitialResultRead({ lockPath }) {
      // Force this invocation down the follower path without scheduling another process.
      mkdirSync(lockPath);
    },
    beforeOwnerLivenessCheck({ lockPath, resultPath }) {
      // The elected builder publishes and removes its lock at the exact boundary between the
      // follower's empty result read and its owner check.
      writeFileSync(resultPath, JSON.stringify({ status: "success" }));
      rmSync(lockPath, { recursive: true });
    },
  });

  expect(existsSync(output)).toBe(false);
});

it.skipIf(!canDisableTypeStripping)(
  "explicitly enables type stripping for the custom build fixture runner",
  async () => {
    const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-build-strip-types-"));
    tempDirs.push(coordinationDir);
    const output = join(coordinationDir, "built.txt");
    process.env.NODE_OPTIONS = "--no-experimental-strip-types";

    const runner = startRunner(
      coordinationDir,
      300,
      coordinationDir,
      command(SUCCESSFUL_BUILD, output),
    );

    await expect(runner.completion).resolves.toEqual({
      code: 0,
      output: JSON.stringify({ status: "success" }),
    });
    expect(readFileSync(output, "utf8")).toBe("built");
  },
);

it("times out a hung process tree and publishes one deterministic failure to every peer", async () => {
  const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-build-timeout-"));
  const nextCoordinationDir = mkdtempSync(join(tmpdir(), "gadgets-build-after-timeout-"));
  tempDirs.push(coordinationDir, nextCoordinationDir);
  const counter = join(coordinationDir, "builds.txt");
  const childPidPath = join(coordinationDir, "child.pid");
  const buildCommand = command(HANGING_BUILD, counter, childPidPath);

  const first = startRunner(coordinationDir, 300, coordinationDir, buildCommand);
  await waitForRunnerReadiness(first, () => existsSync(childPidPath), "hung build child pid");
  const peer = startRunner(coordinationDir, 300, coordinationDir, buildCommand);
  const [firstResult, peerResult] = await Promise.all([first.completion, peer.completion]);

  expect(firstResult.code).toBe(1);
  expect(peerResult.code).toBe(1);
  expect(firstResult.output).toBe(peerResult.output);
  expect(firstResult.output).toContain("Timed out after 300ms");
  expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["build"]);

  const resultName = readdirSync(coordinationDir)
    .find(entry => entry.endsWith(".result.json"));
  expect(resultName).toBeDefined();
  expect(JSON.parse(readFileSync(join(coordinationDir, resultName!), "utf8")))
    .toEqual({ status: "failure", message: JSON.parse(firstResult.output).message });

  const childPid = Number(readFileSync(childPidPath, "utf8"));
  await waitForProcessExit(childPid, "hung build child termination");
  expect(readdirSync(coordinationDir).some(entry => entry.endsWith(".lock"))).toBe(false);

  const output = join(nextCoordinationDir, "built.txt");
  const next = startRunner(
    nextCoordinationDir,
    300,
    nextCoordinationDir,
    command(SUCCESSFUL_BUILD, output),
  );
  await expect(next.completion).resolves.toMatchObject({ code: 0 });
  expect(readFileSync(output, "utf8")).toBe("built");
});

it("waits for runner readiness beyond two seconds", async () => {
  const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-build-delayed-readiness-"));
  tempDirs.push(coordinationDir);
  const counter = join(coordinationDir, "builds.txt");
  const started = join(coordinationDir, "started");
  const release = join(coordinationDir, "release");
  const buildCommand = command(BLOCKING_BUILD, counter, started, release);

  const readyAfter = Date.now() + 2_100;
  const builder = startRunner(coordinationDir, 4_000, coordinationDir, buildCommand);
  await waitForRunnerReadiness(
    builder,
    () => existsSync(started) && Date.now() >= readyAfter,
    "delayed builder startup",
  );
  expect(readFileSync(counter, "utf8")).toBe("build\n");

  closeSync(openSync(release, "w"));
  await expect(builder.completion).resolves.toEqual({
    code: 0,
    output: JSON.stringify({ status: "success" }),
  });
});

it("reports runner completion while waiting for readiness", async () => {
  const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-build-readiness-exit-"));
  tempDirs.push(coordinationDir);
  const output = join(coordinationDir, "built.txt");
  const runner = startRunner(
    coordinationDir,
    300,
    coordinationDir,
    command(SUCCESSFUL_BUILD, output),
  );

  await expect(waitForRunnerReadiness(runner, () => false, "impossible readiness"))
    .rejects.toThrow([
      "Custom build runner exited before impossible readiness (code 0):",
      JSON.stringify({ status: "success" }),
    ].join("\n"));
});

it("treats absent and partial elected-owner metadata as transient", async () => {
  const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-build-owner-transient-"));
  tempDirs.push(coordinationDir);
  const counter = join(coordinationDir, "builds.txt");
  const started = join(coordinationDir, "started");
  const release = join(coordinationDir, "release");
  const buildCommand = command(BLOCKING_BUILD, counter, started, release);

  const builder = startRunner(coordinationDir, 3_000, coordinationDir, buildCommand);
  await waitForRunnerReadiness(builder, () => existsSync(started), "builder startup");
  const lockName = readdirSync(coordinationDir).find(entry => entry.endsWith(".lock"));
  if (!lockName) throw new Error("Builder did not publish its lock");
  const ownerPath = join(coordinationDir, lockName, "owner.json");
  unlinkSync(ownerPath);

  const peer = startRunner(coordinationDir, 3_000, coordinationDir, buildCommand);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(peer.child.exitCode).toBeNull();
  writeFileSync(ownerPath, "{");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(peer.child.exitCode).toBeNull();

  closeSync(openSync(release, "w"));
  await expect(Promise.all([builder.completion, peer.completion])).resolves.toEqual([
    { code: 0, output: JSON.stringify({ status: "success" }) },
    { code: 0, output: JSON.stringify({ status: "success" }) },
  ]);
  expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["build"]);
});
