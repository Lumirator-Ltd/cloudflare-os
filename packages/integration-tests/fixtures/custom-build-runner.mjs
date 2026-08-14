const [coordinationDir, timeoutMs, cwd, command] = process.argv.slice(2);
process.env.GADGETS_INTEGRATION_BUILD_COORDINATION_DIR = coordinationDir;
process.env.GADGETS_INTEGRATION_BUILD_TIMEOUT_MS = timeoutMs;

const { runCustomBuildOnce } = await import("../src/custom-build.ts");
try {
  await runCustomBuildOnce({ command, cwd });
  process.stdout.write(`${JSON.stringify({ status: "success" })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "failure",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
