import { appendFileSync, closeSync, existsSync, openSync } from "node:fs";

const [counterPath, startedPath, releasePath] = process.argv.slice(2);
appendFileSync(counterPath, "build\n");
closeSync(openSync(startedPath, "w"));
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const deadline = Date.now() + 10_000;
while (!existsSync(releasePath) && Date.now() < deadline) sleep(10);
if (!existsSync(releasePath)) throw new Error("Timed out waiting for test release");
