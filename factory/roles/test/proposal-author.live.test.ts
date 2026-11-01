/**
 * Live proposal-author run (add-role-runner task 7.3): the real role, as configured (Opus,
 * 30 turns, $3), against a canned issue in a temp git worktree of this repo at HEAD. Asserts
 * the change folder and the result the scenario names, and that nothing outside the change
 * folder changed. The generated files and the result are printed for review.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProposalResult } from "@vocab/factory-artifacts";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRole } from "../src/config.ts";
import { createCostLog, outcomeOf, removeDir, runProbe } from "./live-harness.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const OPENSPEC = join(REPO, "node_modules/.bin/openspec");
const CHANGE_ID = "add-word-marks";
const CHANGE = `openspec/changes/${CHANGE_ID}`;
const ISSUE = {
  title: "Mark words as known or ignored",
  body: readFileSync(join(import.meta.dirname, "fixtures/mark-words-known-or-ignored.md"), "utf8"),
};

let parent: string;
let worktree: string;
const costs = createCostLog();

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

beforeAll(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "vocab-live-")));
  worktree = join(parent, "worktree");
  git("worktree", "add", "--detach", worktree, "HEAD");
});

afterAll(() => {
  costs.print();
  git("worktree", "remove", "--force", worktree);
  removeDir(parent);
});

describe("live proposal author", () => {
  it("Scenario: Proposal author output is complete", { timeout: 1_200_000 }, async () => {
    const role = await loadRole("proposal-author", { root: worktree });
    expect(role.model).toBe("claude-opus-5-5");
    expect(role.maxBudgetUsd).toBe(3);

    const attempt = await runProbe(role, worktree, { changeId: CHANGE_ID, issue: ISSUE });
    costs.track("Proposal author output is complete", attempt);

    const folder = join(worktree, CHANGE);
    const specDirs = existsSync(join(folder, "specs")) ? readdirSync(join(folder, "specs")) : [];
    const specs = specDirs.map((capability) => `specs/${capability}/spec.md`).filter((path) => existsSync(join(folder, path)));
    const files = ["proposal.md", ".openspec.yaml", ...specs];
    console.log(
      [
        `outcome: ${outcomeOf(attempt)}`,
        `result: ${JSON.stringify(attempt.outcome instanceof Error ? { error: attempt.outcome.message } : attempt.outcome, null, 2)}`,
        ...files.filter((path) => existsSync(join(folder, path))).map((path) => `--- ${CHANGE}/${path}\n${readFileSync(join(folder, path), "utf8")}`),
      ].join("\n"),
    );

    // The runner returns a result only after zod parsing and `openspec validate --strict` both passed.
    expect(outcomeOf(attempt)).toBe("succeeded");
    const result = ProposalResult.parse(attempt.outcome);
    expect(result.changeId).toBe(CHANGE_ID);
    expect(result.capabilities.length).toBeGreaterThan(0);
    // The canned issue ends with an open question, so the list cannot be empty.
    expect(result.openQuestions.length, "the issue's open question is missing from openQuestions").toBeGreaterThan(0);

    expect(existsSync(join(folder, "proposal.md"))).toBe(true);
    expect(specs.length, "no delta spec").toBeGreaterThan(0);
    const metadata = parse(readFileSync(join(folder, ".openspec.yaml"), "utf8")) as Record<string, unknown>;
    expect(metadata["x-complexity"]).toBe(result.complexity);

    // Strict validation, run again here so the test does not rest on the runner alone.
    execFileSync(OPENSPEC, ["validate", CHANGE_ID, "--strict", "--no-interactive"], {
      cwd: worktree,
      env: { ...process.env, OPENSPEC_TELEMETRY: "0" },
    });

    // Nothing outside the change folder changed.
    const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree, encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(3));
    expect(changed.filter((path) => !path.startsWith(`${CHANGE}/`))).toEqual([]);
  });
});
