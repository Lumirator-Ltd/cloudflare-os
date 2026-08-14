import { it } from "vitest";
import { runConcurrentHarnessStartup } from "../fixtures/concurrent-harness-start.js";

it("coordinates a shared custom build before concurrent harness B starts", async () => {
  await runConcurrentHarnessStartup("b");
});
