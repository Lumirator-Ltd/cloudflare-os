import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], "built");
