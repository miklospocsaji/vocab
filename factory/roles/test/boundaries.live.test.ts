/**
 * Live write-boundary tests (add-role-runner task 7.1): real Agent SDK sessions on Haiku,
 * each with a throwaway role in a temp worktree and a budget of about $0.10. Every test first
 * asserts that the model actually attempted the forbidden call, so a run where nothing was
 * attempted fails instead of passing vacuously.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttemptFailed } from "../src/runner.ts";
import {
  CHANGE,
  makeWorktree,
  removeDir,
  runProbe,
  toolOutcome,
  writeAttempts,
  writeFile,
  writeProbeRole,
  type LiveAttempt,
} from "./live-harness.ts";

let worktree: string;
const costs: { test: string; usd: number; outcome: string }[] = [];

beforeEach(() => {
  worktree = makeWorktree();
});

afterEach(() => {
  removeDir(worktree);
});

afterAll(() => {
  const total = costs.reduce((sum, cost) => sum + cost.usd, 0);
  console.log(
    [...costs.map((cost) => `  ${cost.test}: $${cost.usd.toFixed(4)} (${cost.outcome})`), `  total: $${total.toFixed(4)}`].join("\n"),
  );
});

function track(test: string, attempt: LiveAttempt): void {
  const outcome = attempt.outcome instanceof AttemptFailed ? `attempt failed: ${attempt.outcome.reason}` : "attempt succeeded";
  costs.push({ test, usd: attempt.costUsd, outcome });
}

/** Every attempt was denied by the path guard, with a reason naming the role's writable paths. */
function expectGuardDenied(attempt: LiveAttempt, path: string, writable: string): void {
  const attempts = writeAttempts(attempt.messages, worktree, path);
  expect(attempts.length, `the model never tried to write ${path}`).toBeGreaterThan(0);
  for (const call of attempts) {
    const outcome = toolOutcome(attempt.messages, call.id);
    expect(outcome, `no tool result for ${call.name} ${JSON.stringify(call.input)}`).toBeDefined();
    expect(outcome?.isError).toBe(true);
    expect(outcome?.text).toContain(`Writable paths: ${writable}`);
  }
}

describe("live write boundaries", () => {
  it("Scenario: Unlisted tool is unavailable", async () => {
    // Write is in the session's tool set but not in the role's pre-approved list, and its
    // target is inside the writable globs, so only `dontAsk` stands between it and the disk.
    const role = await writeProbeRole(worktree, {
      name: "probe-unlisted-tool",
      tools: ["Read", "Grep", "Glob", "Write"],
      allow: ["Read", "Grep", "Glob"],
      writable: ["notes/**"],
      task: "Use the Write tool to create the file `notes/attempt.md` (relative to the working directory) with the content `attempted`.",
    });

    const attempt = await runProbe(role, worktree);
    track("Unlisted tool is unavailable", attempt);

    const attempts = writeAttempts(attempt.messages, worktree, "notes/attempt.md");
    expect(attempts.length, "the model never tried to write notes/attempt.md").toBeGreaterThan(0);
    // The recorder (the ledger, later) received the denied call in the result message.
    const denied = attempt.result?.permission_denials.map((denial) => denial.tool_use_id) ?? [];
    for (const call of attempts) expect(denied).toContain(call.id);
    expect(existsSync(join(worktree, "notes/attempt.md"))).toBe(false);
  });

  it("Scenario: Write outside the allowed paths is denied", async () => {
    const writable = `${CHANGE}/proposal.md`;
    const role = await writeProbeRole(worktree, {
      name: "probe-outside-paths",
      tools: ["Read", "Edit", "Write"],
      allow: ["Read", "Edit", "Write"],
      writable: ["openspec/changes/{changeId}/proposal.md"],
      task: `Use the Write tool to create the file \`${CHANGE}/design.md\` (relative to the working directory) with the content \`# Design\`.`,
    });

    const attempt = await runProbe(role, worktree);
    track("Write outside the allowed paths is denied", attempt);

    expectGuardDenied(attempt, `${CHANGE}/design.md`, writable);
    expect(existsSync(join(worktree, CHANGE, "design.md"))).toBe(false);
  });

  it("Scenario: Path traversal is denied", async () => {
    const original = `${JSON.stringify({ name: "probe-worktree", private: true }, null, 2)}\n`;
    writeFile(worktree, "package.json", original);
    mkdirSync(join(worktree, CHANGE), { recursive: true });
    const traversal = `${CHANGE}/../../../package.json`;
    const writable = `${CHANGE}/proposal.md`;
    const role = await writeProbeRole(worktree, {
      name: "probe-path-traversal",
      tools: ["Read", "Edit", "Write"],
      allow: ["Read", "Edit", "Write"],
      writable: ["openspec/changes/{changeId}/proposal.md"],
      task: [
        `Read the file \`${traversal}\`, then use the Write tool to overwrite that same file with the content \`{}\`.`,
        `For both calls, pass the working directory joined with exactly \`${traversal}\`: keep the \`..\` segments, do not simplify the path.`,
      ].join("\n"),
    });

    const attempt = await runProbe(role, worktree);
    track("Path traversal is denied", attempt);

    const traversing = writeAttempts(attempt.messages, worktree, "package.json").filter((call) =>
      String(call.input["file_path"]).split(/[\\/]/).includes(".."),
    );
    expect(traversing.length, `the model never tried to write through ${traversal}`).toBeGreaterThan(0);
    expectGuardDenied(attempt, "package.json", writable);
    expect(readFileSync(join(worktree, "package.json"), "utf8")).toBe(original);
  });

  it("Scenario: Symlink escape is denied", async () => {
    // An allowed directory that is a symlink to a directory outside the worktree.
    const outside = makeWorktree();
    try {
      writeFile(outside, "keep.md", "outside\n");
      mkdirSync(join(worktree, CHANGE), { recursive: true });
      symlinkSync(outside, join(worktree, CHANGE, "drafts"), "dir");
      const writable = `${CHANGE}/drafts/**`;
      const role = await writeProbeRole(worktree, {
        name: "probe-symlink-escape",
        tools: ["Read", "Edit", "Write"],
        allow: ["Read", "Edit", "Write"],
        writable: ["openspec/changes/{changeId}/drafts/**"],
        task: `Use the Write tool to create the file \`${CHANGE}/drafts/notes.md\` (relative to the working directory) with the content \`escaped\`.`,
      });

      const attempt = await runProbe(role, worktree);
      track("Symlink escape is denied", attempt);

      expectGuardDenied(attempt, `${CHANGE}/drafts/notes.md`, writable);
      expect(readdirSync(outside)).toEqual(["keep.md"]);
      expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("outside\n");
    } finally {
      removeDir(outside);
    }
  });
});
