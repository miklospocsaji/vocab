// Writes this process's environment to env-<check>.json in the working directory.
import { writeFileSync } from "node:fs";

writeFileSync(`env-${process.argv[2] ?? "unknown"}.json`, JSON.stringify(process.env));
