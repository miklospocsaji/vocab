import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GatesResult } from "@vocab/factory-artifacts";
import { z } from "zod";
import { checkCoverage } from "./coverage.ts";
import { runGates } from "./run.ts";

const USAGE = `Usage:
  pnpm gates red|green --change <id> --task <id> --scenarios <file.json> [--worktree <dir>]
  pnpm gates coverage --change <id> [--tests <dir>] [--worktree <dir>]

<file.json> holds { "scenarios": [titles], "coveredSoFar": [titles] }; coveredSoFar is for green.
Prints gates.json to stdout. Exits 0 when the gates pass, 1 when they fail, 2 on bad input.
`;

const ScenariosFile = z.strictObject({
  scenarios: z.array(z.string().min(1)),
  coveredSoFar: z.array(z.string().min(1)).optional(),
});

class UsageError extends Error {}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new UsageError(`${flag} is required`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      change: { type: "string" },
      task: { type: "string" },
      scenarios: { type: "string" },
      tests: { type: "string" },
      worktree: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`unexpected arguments: ${rest.join(" ")}`);
  const changeId = required(values.change, "--change");
  if (!/^[a-z][a-z0-9-]*$/.test(changeId)) throw new UsageError(`--change is not a change id: ${changeId}`);
  const worktree = resolve(values.worktree ?? process.cwd());

  let result: GatesResult;
  if (command === "red" || command === "green") {
    const taskId = required(values.task, "--task");
    const file = required(values.scenarios, "--scenarios");
    const parsed = ScenariosFile.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new UsageError(`${file}: ${parsed.error.message}`);
    result = await runGates({ worktree, changeId, mode: command, task: { id: taskId, ...parsed.data } });
  } else if (command === "coverage") {
    // Scenario coverage of the whole change, outside any task; --tests replaces app/ (for the factory's own changes).
    const started = performance.now();
    const coverage = await checkCoverage({ worktree, changeId, testsDir: values.tests });
    const output = coverage.passed ? "Every scenario has a test.\n" : coverage.missing.map((title) => `No test names the scenario: ${title}\n`).join("");
    result = GatesResult.parse({
      mode: "green",
      changeId,
      taskId: "all",
      passed: coverage.passed,
      checks: [{ name: "coverage", passed: coverage.passed, exitCode: null, durationMs: Math.round(performance.now() - started), output, missing: coverage.missing }],
    });
  } else {
    throw new UsageError(command === undefined ? "a command is required" : `unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.passed ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const usage = error instanceof UsageError || error instanceof TypeError || error instanceof SyntaxError || (error as { code?: string }).code === "ENOENT";
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage ? USAGE : ""}`);
    process.exitCode = usage ? 2 : 1;
  },
);
