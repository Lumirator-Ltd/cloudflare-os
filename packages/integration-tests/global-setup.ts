import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_COORDINATION_DIR_ENV } from "./src/custom-build.js";

export default function setup(): () => void {
  // A fresh directory makes completion records run-scoped: a crash can leave files behind, but a
  // later Vitest run never mistakes them for a current lock or successful build.
  const coordinationDir = mkdtempSync(join(tmpdir(), "gadgets-integration-builds-"));
  process.env[BUILD_COORDINATION_DIR_ENV] = coordinationDir;

  return () => {
    delete process.env[BUILD_COORDINATION_DIR_ENV];
    rmSync(coordinationDir, { recursive: true, force: true });
  };
}
