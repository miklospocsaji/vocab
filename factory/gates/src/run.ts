import { GatesResult, type GateCheck } from "@vocab/factory-artifacts";
import * as checks from "./checks.ts";
import { checkCoverage } from "./coverage.ts";
import { boundOutput, redact } from "./redact.ts";
import { readVitestReport, type VitestFile } from "./vitest-report.ts";

/** One task of a change: its id and its scenario titles. */
export type GatesTask = {
  id: string;
  scenarios: readonly string[];
  /** Green mode: the titles of every task done so far, this one included. */
  coveredSoFar?: readonly string[] | undefined;
};

export type RunGatesOptions = {
  worktree: string;
  changeId: string;
  task: GatesTask;
  mode: "red" | "green";
  /** Values to replace with `[redacted]` in every field of the result. */
  secrets?: readonly string[] | undefined;
};

type GateTest = NonNullable<GateCheck["tests"]>[number];

function commandCheck(name: GateCheck["name"], result: checks.CommandResult, passed = result.exitCode === 0): GateCheck {
  return { name, passed, exitCode: result.exitCode, durationMs: result.durationMs, output: result.output };
}

/** The report's files, or null when Vitest wrote no report or one without the pinned fields. */
function parseReport(run: checks.UnitRun, worktree: string): VitestFile[] | null {
  if (run.report === null) return null;
  try {
    return readVitestReport(run.report, worktree);
  } catch {
    return null;
  }
}

function loadErrors(files: readonly VitestFile[]): GateTest[] {
  return files.filter((file) => file.loadError !== undefined).map((file) => ({ file: file.file, name: "", problem: "load-error" }));
}

function failedTests(files: readonly VitestFile[], skip: (name: string) => boolean = () => false): GateTest[] {
  return files.flatMap((file) =>
    file.tests.filter((test) => test.status === "failed" && !skip(test.name)).map((test) => ({ file: file.file, name: test.name, problem: "failed" as const })),
  );
}

function namesScenario(name: string, scenarios: readonly string[]): boolean {
  return scenarios.some((title) => name.includes(`Scenario: ${title}`));
}

/** The red check: the task's tests exist and fail while they run, and nothing else fails. */
function redCheck(files: VitestFile[] | null, scenarios: readonly string[]): GateCheck {
  const started = performance.now();
  if (files === null) {
    return { name: "red", passed: false, exitCode: null, durationMs: 0, output: "Vitest wrote no report; see the unit check's output.\n" };
  }
  const isNew = (name: string) => namesScenario(name, scenarios);
  const ran = files.flatMap((file) => file.tests.filter((test) => test.status !== "skipped"));
  const missing = scenarios.filter((title) => !ran.some((test) => test.name.includes(`Scenario: ${title}`)));
  const passedNew: GateTest[] = files.flatMap((file) =>
    file.tests.filter((test) => test.status === "passed" && isNew(test.name)).map((test) => ({ file: file.file, name: test.name, problem: "passed" as const })),
  );
  const tests = [...loadErrors(files), ...passedNew, ...failedTests(files, isNew)];

  const lines: string[] = [];
  for (const title of missing) lines.push(`No test names the scenario: ${title}`);
  for (const file of files) if (file.loadError !== undefined) lines.push(`Failed to load: ${file.file}\n${file.loadError}`);
  for (const test of passedNew) lines.push(`Passes already, but must fail until the task is built: ${test.file} > ${test.name}`);
  for (const file of files) {
    for (const test of file.tests) {
      if (test.status === "failed" && !isNew(test.name)) lines.push(`Fails, but is not a test of this task: ${file.file} > ${test.name}\n${test.failure ?? ""}`);
    }
  }
  const passed = missing.length === 0 && tests.length === 0;
  if (passed) lines.push(`Every scenario of the task has a test, each fails while it runs, and every other test passes.`);
  return { name: "red", passed, exitCode: null, durationMs: Math.round(performance.now() - started), output: `${lines.join("\n")}\n`, missing, tests };
}

/** Replaces the secrets in every string of the result and cuts each output to 16 KB. */
function clean(result: GatesResult, secrets: readonly string[]): GatesResult {
  const hide = (text: string) => redact(text, secrets);
  return {
    ...result,
    checks: result.checks.map((check) => ({
      ...check,
      ...(check.output === undefined ? {} : { output: boundOutput(hide(check.output)) }),
      ...(check.missing === undefined ? {} : { missing: check.missing.map(hide) }),
      ...(check.tests === undefined ? {} : { tests: check.tests.map((test) => ({ ...test, file: hide(test.file), name: hide(test.name) })) }),
    })),
  };
}

/**
 * Runs the red or green gates for one task in a worktree. Every check of the mode runs, even
 * after one fails. Only the app's tests run, with a fixed environment (see `checkEnv`).
 */
export async function runGates(options: RunGatesOptions): Promise<GatesResult> {
  const { worktree, changeId, task, mode } = options;
  const results: GateCheck[] = [];
  results.push(commandCheck("typecheck", await checks.typecheck(worktree)));
  results.push(commandCheck("lint", await checks.lint(worktree)));

  const run = await checks.unit(worktree);
  const files = parseReport(run, worktree);
  if (mode === "red") {
    // The unit run itself only has to produce a report: the red check judges its failures.
    results.push(commandCheck("unit", run, files !== null));
    results.push(redCheck(files, task.scenarios));
  } else {
    const unitCheck = commandCheck("unit", run, run.exitCode === 0 && files !== null);
    results.push(files === null ? unitCheck : { ...unitCheck, tests: [...loadErrors(files), ...failedTests(files)] });
    results.push(commandCheck("spec", await checks.spec(worktree, changeId)));
    const started = performance.now();
    const coverage = await checkCoverage({ worktree, changeId, scenarios: task.coveredSoFar ?? task.scenarios, report: files ?? undefined });
    const output = coverage.passed ? "Every scenario has a test.\n" : coverage.missing.map((title) => `No test names the scenario: ${title}\n`).join("");
    results.push({ name: "coverage", passed: coverage.passed, exitCode: null, durationMs: Math.round(performance.now() - started), output, missing: coverage.missing });
  }

  const result: GatesResult = { mode, changeId, taskId: task.id, passed: results.every((check) => check.passed), checks: results };
  return GatesResult.parse(clean(result, options.secrets ?? []));
}
