/**
 * Test helper: a scripted fake of the build container (`RunBuild`). Each call plays the next step
 * of the script the way `factory-build` ends a run:
 * - it reads the task's `next.json` and the `input.json` it points at, checked with the build
 *   container's own `BuildInput` schema
 * - it clones `cloneUrl` at `baseCommit` with no token; in `gates-only` mode it applies the given
 *   patch, otherwise it writes the step's files
 * - it writes `patch.diff`, `gates.json` (unless the step failed before the gates),
 *   `messages.jsonl` (an init and a result message, none in `gates-only` mode) and `outcome.json`
 *   next to the input key; a `noOutcome` step writes nothing, as a crashed build task
 * Every call is kept, with the `next.json` and `input.json` it read.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { BuildOutcome, GatesResult } from "@vocab/factory-artifacts";
import { diffPatch } from "@vocab/factory-roles";
import { init, result } from "../../ledger/test/messages.ts";
import { BuildInput } from "../../worker/src/build.ts";
import { nextBuildKey, parseNextBuild, type ArtifactStore, type NextBuild, type RunBuild } from "../src/build-io.ts";

export interface FakeBuildStep {
  /** Files to write in the clone, worktree-relative. Ignored in `gates-only` mode. */
  files?: Record<string, string>;
  /** Defaults to `passed`. */
  outcome?: "passed" | "failed";
  /** A failed step's reason; defaults to the gate's mode (`red` or `green`). */
  reason?: NonNullable<BuildOutcome["reason"]>;
  /** The failed check's output, when the gates failed. */
  output?: string;
  /** What `outcome.json` claims about the diff check; defaults to a passed one. */
  diffCheck?: { passed: boolean; outside: string[] };
  /** The SDK's estimated cost of the session; defaults to 0.4. */
  costUsd?: number;
  /** Writes no outcome at all, as a build task that crashed. */
  noOutcome?: boolean;
}

export interface FakeBuildCall {
  taskId: string;
  next: NextBuild;
  input: BuildInput;
}

export interface FakeBuildRunner {
  runBuild: RunBuild;
  calls: FakeBuildCall[];
  /** Appends steps to the script. */
  script(...steps: FakeBuildStep[]): void;
}

/** Reasons a build fails with before its gates run. */
const BEFORE_GATES: readonly string[] = ["max-turns", "budget", "error", "no-result", "invalid-result", "invalid-change", "auth-mode-mismatch", "config", "diff-check"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

export function createFakeBuildRunner(store: ArtifactStore, steps: FakeBuildStep[] = []): FakeBuildRunner {
  const calls: FakeBuildCall[] = [];
  const queue = [...steps];

  const runBuild: RunBuild = async ({ changeId, taskId }) => {
    const next = parseNextBuild(await store.get(nextBuildKey(changeId, taskId)));
    const input = BuildInput.parse(JSON.parse(await store.get(next.input)));
    calls.push({ taskId, next, input });
    const scripted = queue.shift();
    if (scripted === undefined) throw new Error(`fake build runner: call ${String(calls.length)} has no scripted step`);
    if (scripted.noOutcome === true) return;

    const prefix = posix.dirname(next.input);
    const key = (file: string) => `${prefix}/${file}`;
    const mode = next.role === "test-author" ? "red" : "green";
    const gatesOnly = next.mode === "gates-only";

    const root = mkdtempSync(join(tmpdir(), "fake-build-"));
    try {
      const clone = join(root, "work");
      git(root, "clone", "--quiet", "--no-checkout", "--branch", input.branch, "--", input.cloneUrl, clone);
      git(clone, "checkout", "--quiet", "--detach", input.baseCommit);
      if (gatesOnly) {
        const patchFile = join(root, "patch.diff");
        writeFileSync(patchFile, await store.get(next.patch ?? ""));
        git(clone, "apply", patchFile);
      } else {
        for (const [path, content] of Object.entries(scripted.files ?? {})) {
          mkdirSync(dirname(join(clone, path)), { recursive: true });
          writeFileSync(join(clone, path), content);
        }
      }

      const failed = scripted.outcome === "failed";
      const reason = failed ? (scripted.reason ?? mode) : undefined;
      const gatesRan = !(reason !== undefined && BEFORE_GATES.includes(reason));
      const gatesKey = key("gates.json");
      if (gatesRan) {
        const gates: GatesResult = {
          mode,
          changeId,
          taskId,
          passed: !failed,
          checks: [
            {
              name: mode === "red" ? "red" : "unit",
              passed: !failed,
              exitCode: mode === "red" ? null : failed ? 1 : 0,
              durationMs: 10,
              ...(failed ? { output: scripted.output ?? `${mode} gate failed` } : {}),
            },
          ],
        };
        await store.put(gatesKey, `${JSON.stringify(gates, null, 2)}\n`);
      }

      const patchKey = key("patch.diff");
      const messagesKey = key("messages.jsonl");
      await store.put(patchKey, await diffPatch(clone, input.baseCommit));
      const messages = gatesOnly ? [] : [init("none"), result({ input: 2000, output: 800, cacheRead: 100, cacheCreation: 50 }, scripted.costUsd ?? 0.4)];
      await store.put(messagesKey, messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
      const outcome = {
        role: next.role,
        outcome: failed ? "failed" : "passed",
        ...(reason === undefined ? {} : { reason }),
        ...(gatesOnly || failed ? {} : { roleResult: next.role === "test-author" ? { tests: [], stubs: [], notes: "" } : { summary: "Implemented the task.", notes: "" } }),
        diffCheck: scripted.diffCheck ?? { passed: reason !== "diff-check", outside: reason === "diff-check" ? ["package.json"] : [] },
        ...(gatesRan ? { gates: gatesKey } : {}),
        patch: patchKey,
        messages: messagesKey,
        baseCommit: input.baseCommit,
      };
      await store.put(key("outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  return { runBuild, calls, script: (...more) => queue.push(...more) };
}
