import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** What one command check returns, before redaction and bounding. */
export type CommandResult = {
  exitCode: number | null;
  durationMs: number;
  output: string;
};

/** How much of a command's combined output is kept in memory; only the end is ever reported. */
const KEPT_OUTPUT_BYTES = 1024 * 1024;

/**
 * The only environment a check runs with: nothing else of the runner's environment, so no
 * credential, database URL or `NODE_OPTIONS` reaches the code under test.
 */
export function checkEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: source["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: source["HOME"] ?? tmpdir(),
    TMPDIR: source["TMPDIR"] ?? tmpdir(),
    CI: "1",
    OPENSPEC_TELEMETRY: "0",
  };
}

/** Runs one command in the worktree, without a shell, and collects stdout and stderr together. */
export function runCommand(worktree: string, command: string, args: readonly string[]): Promise<CommandResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    const collect = (chunk: Buffer) => {
      chunks.push(chunk);
      kept += chunk.length;
      while (kept - (chunks[0]?.length ?? 0) >= KEPT_OUTPUT_BYTES) kept -= chunks.shift()?.length ?? 0;
    };
    const child = spawn(command, args, { cwd: worktree, env: checkEnv(), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (exitCode: number | null, extra = "") => {
      resolve({
        exitCode,
        durationMs: Math.round(performance.now() - started),
        output: stripVTControlCharacters(Buffer.concat(chunks).toString("utf8") + extra),
      });
    };
    child.on("error", (error) => {
      finish(null, `\n${command} could not start: ${error.message}\n`);
    });
    child.on("close", (code, signal) => {
      finish(code, signal ? `\n${command} ended on ${signal}\n` : "");
    });
  });
}

export function typecheck(worktree: string): Promise<CommandResult> {
  return runCommand(worktree, "pnpm", ["typecheck"]);
}

export function lint(worktree: string): Promise<CommandResult> {
  return runCommand(worktree, "pnpm", ["lint"]);
}

export function spec(worktree: string, changeId: string): Promise<CommandResult> {
  return runCommand(worktree, "pnpm", ["exec", "openspec", "validate", changeId, "--strict", "--no-interactive"]);
}

/** The unit run's command result and its JSON report, or null when Vitest wrote none. */
export type UnitRun = CommandResult & { report: unknown };

/**
 * Runs the app's unit tests once, with the default reporter for the output (test logs and
 * failures) and the JSON reporter for the report the red check and coverage read.
 */
export async function unit(worktree: string): Promise<UnitRun> {
  const dir = await mkdtemp(join(tmpdir(), "gates-vitest-"));
  try {
    const reportFile = join(dir, "report.json");
    const result = await runCommand(worktree, "pnpm", [
      "exec", "vitest", "run", "--project", "unit",
      "--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`,
      "app/",
    ]);
    const report: unknown = await readFile(reportFile, "utf8").then((text) => JSON.parse(text) as unknown, () => null);
    return { ...result, report };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
