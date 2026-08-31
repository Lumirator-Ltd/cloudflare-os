import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const counter = join(dir, "builds.txt");
const generatedWorker = join(dir, "generated-worker.ts");
const firstInvocation = join(dir, "first-invocation");
const secondStarted = join(dir, "second-started");
const firstCompleted = join(dir, "first-completed");
const outputRemoved = join(dir, "output-removed");

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (path, timeout = 2_000) => {
  const deadline = Date.now() + timeout;
  while (!existsSync(path) && Date.now() < deadline) sleep(10);
  return existsSync(path);
};
const writeWorker = () => writeFileSync(generatedWorker, `
export default {
  fetch(): Response {
    return Response.json({ ready: true });
  },
} satisfies ExportedHandler;
`);

mkdirSync(dir, { recursive: true });
appendFileSync(counter, "build\n");

let first = false;
try {
  closeSync(openSync(firstInvocation, "wx"));
  first = true;
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
}

if (first) {
  if (waitFor(secondStarted)) {
    writeWorker();
    closeSync(openSync(firstCompleted, "w"));
    waitFor(outputRemoved);
  } else {
    writeWorker();
  }
} else {
  closeSync(openSync(secondStarted, "w"));
  if (!waitFor(firstCompleted)) throw new Error("First concurrent build did not complete");
  rmSync(generatedWorker, { force: true });
  closeSync(openSync(outputRemoved, "w"));
  sleep(1_000);
  writeWorker();
}
