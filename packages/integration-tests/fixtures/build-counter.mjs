import { appendFileSync } from "node:fs";

appendFileSync(process.argv[2], "build\n");
