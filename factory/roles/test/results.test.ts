import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ReviewResult } from "@vocab/factory-artifacts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Role } from "../src/config.ts";
import { AttemptFailed, createRunner, type QueryFn } from "../src/runner.ts";

let worktree: string;

beforeEach(() => {
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "vocab-results-")));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

const reviewer: Role = {
  name: "design-reviewer",
  model: "claude-sonnet-5-5",
  runsIn: "worker",
  tools: ["Read", "Grep", "Glob"],
  allow: ["Read", "Grep", "Glob"],
  writable: [],
  skills: [],
  maxTurns: 20,
  maxBudgetUsd: 0.5,
  resultSchema: "review-result",
  authMode: "subscription",
  prompt: "You review designs.",
  schema: ReviewResult,
};

/** A fake session that starts in subscription mode and ends with the given structured output. */
function session(structuredOutput: unknown): QueryFn {
  // Only the fields the runner reads; the full SDK shapes are pinned in runner.test.ts.
  const messages = [
    { type: "system", subtype: "init", apiKeySource: "none", session_id: "s" },
    { type: "result", subtype: "success", is_error: false, result: "Done.", structured_output: structuredOutput, session_id: "s" },
  ] as unknown as SDKMessage[];
  return () =>
    (async function* () {
      for (const message of messages) yield await Promise.resolve(message);
    })();
}

async function attempt(structuredOutput: unknown): Promise<unknown> {
  const runRole = createRunner({ query: session(structuredOutput), recorder: { record: () => Promise.resolve() }, env: { PATH: "/usr/bin" } });
  const item = { id: "item-1", changeId: "add-sample", worktree, issue: { title: "Add a sample", body: "Please add a sample." }, changeFiles: [], specs: [] };
  return runRole(reviewer, item).then(
    (result) => result,
    (error: unknown) => error,
  );
}

describe("design reviewer results", () => {
  it("Scenario: Changes requested come with findings", async () => {
    const minorOnly = {
      verdict: "changes-requested",
      findings: [{ severity: "minor", location: "design.md#Overview", summary: "Wording." }],
    };
    expect(ReviewResult.safeParse(minorOnly).success).toBe(false);

    const error = await attempt(minorOnly);
    expect(error).toBeInstanceOf(AttemptFailed);
    expect(error).toMatchObject({ reason: "invalid-result" });

    // Control: the same verdict with a major finding gets past the schema; the attempt then
    // fails only on the change's strict validation, since the temp worktree holds no change.
    const withMajor = { ...minorOnly, findings: [...minorOnly.findings, { severity: "major", location: "design.md#Data model", summary: "Contradicts the spec." }] };
    expect(ReviewResult.safeParse(withMajor).success).toBe(true);
    expect(await attempt(withMajor)).not.toMatchObject({ reason: "invalid-result" });
  });
});
