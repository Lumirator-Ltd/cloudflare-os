import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [counterPath, childPidPath] = process.argv.slice(2);
appendFileSync(counterPath, "build\n");
const child = spawn(process.execPath, ["-e", `
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
`], { stdio: "ignore" });
writeFileSync(childPidPath, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
