/**
 * Live proposal-author run (add-role-runner task 7.3, reworked in add-factory-worker task 1.9):
 * the real role, as configured (Opus, 30 turns, $1.50 per attempt, no Bash), against a canned
 * issue in a temp git worktree of this repo at HEAD. Like the Proposal handler, it retries a
 * failed attempt with its evidence, up to three attempts in all. Asserts the change folder, the
 * result and the Bash-free session the scenarios name, and that nothing outside the change
 * folder changed. The generated files, the attempts and their costs are printed for review.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProposalResult } from "@vocab/factory-artifacts";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRole, type Role } from "../src/config.ts";
import type { PromptArtifact, RetryEvidence } from "../src/prompt.ts";
import { AttemptFailed } from "../src/runner.ts";
import { createCostLog, outcomeOf, removeDir, runProbe, toolCalls, type LiveAttempt } from "./live-harness.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const OPENSPEC = join(REPO, "node_modules/.bin/openspec");
const CHANGE_ID = "add-word-marks";
const CHANGE = `openspec/changes/${CHANGE_ID}`;
const ISSUE = {
  title: "Mark words as known or ignored",
  body: readFileSync(join(import.meta.dirname, "fixtures/mark-words-known-or-ignored.md"), "utf8"),
};

/** MAX_PROPOSAL_ATTEMPTS in factory/orchestrator/src/proposal.ts; roles does not depend on orchestrator. */
const MAX_ATTEMPTS = 3;

let parent: string;
let worktree: string;
let role: Role;
const attempts: LiveAttempt[] = [];
const costs = createCostLog();

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

/** The files in the change folder, as the Proposal handler passes them to a retry. */
function changeFolderFiles(): PromptArtifact[] {
  const folder = join(worktree, CHANGE);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(worktree, join(entry.parentPath, entry.name)))
    .sort()
    .map((path) => ({ path, content: readFileSync(join(worktree, path), "utf8") }));
}

beforeAll(async () => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "vocab-live-")));
  worktree = join(parent, "worktree");
  git("worktree", "add", "--detach", worktree, "HEAD");

  role = await loadRole("proposal-author", { root: worktree });
  let evidence: RetryEvidence | undefined;
  while (attempts.length < MAX_ATTEMPTS) {
    const attempt = await runProbe(role, worktree, {
      changeId: CHANGE_ID,
      issue: ISSUE,
      changeFiles: changeFolderFiles(),
      ...(evidence === undefined ? {} : { evidence }),
    });
    attempts.push(attempt);
    costs.track(`proposal attempt ${String(attempts.length)}`, attempt);
    if (!(attempt.outcome instanceof AttemptFailed) || attempt.outcome.reason === "auth-mode-mismatch") break;
    evidence = { reason: attempt.outcome.reason, evidence: attempt.outcome.evidence };
  }

  const last = attempts.at(-1);
  const folder = join(worktree, CHANGE);
  console.log(
    [
      `attempts: ${String(attempts.length)} (${attempts.map(outcomeOf).join(", ")})`,
      `result: ${JSON.stringify(last?.outcome instanceof Error ? { error: last.outcome.message } : last?.outcome, null, 2)}`,
      ...changeFolderFiles().map((file) => `--- ${file.path}\n${file.content}`),
      ...(existsSync(folder) ? [] : ["(no change folder)"]),
    ].join("\n"),
  );
}, 3_600_000);

afterAll(() => {
  costs.print();
  git("worktree", "remove", "--force", worktree);
  removeDir(parent);
});

describe("live proposal author", () => {
  it("Scenario: Proposal author output is complete", () => {
    expect(role.model).toBe("claude-opus-5-5");
    expect(role.maxBudgetUsd).toBe(1.5);
    const attempt = attempts.at(-1);

    const folder = join(worktree, CHANGE);
    const specDirs = existsSync(join(folder, "specs")) ? readdirSync(join(folder, "specs")) : [];
    const specs = specDirs.map((capability) => `specs/${capability}/spec.md`).filter((path) => existsSync(join(folder, path)));

    // The runner returns a result only after zod parsing and `openspec validate --strict` both passed.
    expect(attempt && outcomeOf(attempt)).toBe("succeeded");
    const result = ProposalResult.parse(attempt?.outcome);
    expect(result.changeId).toBe(CHANGE_ID);
    expect(result.capabilities.length).toBeGreaterThan(0);
    // The canned issue ends with an open question, so the list cannot be empty.
    expect(result.openQuestions.length, "the issue's open question is missing from openQuestions").toBeGreaterThan(0);

    expect(existsSync(join(folder, "proposal.md"))).toBe(true);
    expect(specs.length, "no delta spec").toBeGreaterThan(0);
    const metadata = parse(readFileSync(join(folder, ".openspec.yaml"), "utf8")) as Record<string, unknown>;
    expect(metadata["x-complexity"]).toBe(result.complexity);

    // Nothing outside the change folder changed.
    const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree, encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(3));
    expect(changed.filter((path) => !path.startsWith(`${CHANGE}/`))).toEqual([]);
  });

  it("Scenario: Proposal author produces a valid change without Bash", () => {
    expect(attempts.length, "no attempt ran").toBeGreaterThan(0);
    expect(attempts.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
    const last = attempts.at(-1);
    expect(last && outcomeOf(last)).toBe("succeeded");

    // No attempt had Bash: not offered, not pre-approved, not in the session's tools, never called.
    for (const [index, attempt] of attempts.entries()) {
      const label = `attempt ${String(index + 1)}`;
      expect(attempt.sent?.options.tools, label).not.toContain("Bash");
      expect(
        (attempt.sent?.options.allowedTools ?? []).filter((rule) => rule === "Bash" || rule.startsWith("Bash(")),
        label,
      ).toEqual([]);
      const init = attempt.messages.find((message): message is SDKSystemMessage => message.type === "system" && message.subtype === "init");
      expect(init, `${label}: the session never started`).toBeDefined();
      expect(init?.tools, label).not.toContain("Bash");
      expect(toolCalls(attempt.messages).filter((call) => call.name === "Bash"), label).toEqual([]);
    }

    // Strict validation, run again here so the test does not rest on the runner alone.
    execFileSync(OPENSPEC, ["validate", CHANGE_ID, "--strict", "--no-interactive"], {
      cwd: worktree,
      env: { ...process.env, OPENSPEC_TELEMETRY: "0" },
    });
  });
});
