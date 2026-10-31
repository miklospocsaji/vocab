import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { ProposalResult } from "@vocab/factory-artifacts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRole, writableFor } from "../src/config.ts";
import { createPathGuard } from "../src/guard.ts";

const ROLE = "proposal-author";
const CHANGE_ID = "add-sample";
const CHANGE = `openspec/changes/${CHANGE_ID}`;

let worktree: string;

beforeEach(() => {
  // realpath: the temp dir may itself sit behind a symlink.
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "vocab-proposal-author-")));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

// The real guard decides, so these tests check the globs as the runner enforces them.
async function decide(filePath: string): Promise<string | undefined> {
  const role = await loadRole(ROLE);
  const guard = createPathGuard({ role: ROLE, worktree, writable: writableFor(role, CHANGE_ID) });
  const input: PreToolUseHookInput = {
    hook_event_name: "PreToolUse",
    session_id: "session",
    transcript_path: join(worktree, "transcript.jsonl"),
    cwd: worktree,
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "x" },
    tool_use_id: "tool-use",
  };
  const output: HookJSONOutput = await guard(input, "tool-use", { signal: new AbortController().signal });
  const specific = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
  return specific?.hookEventName === "PreToolUse" ? specific.permissionDecision : undefined;
}

describe("proposal-author role", () => {
  it("loads with the config of task 6.2", async () => {
    const role = await loadRole(ROLE);
    expect(role).toMatchObject({
      name: ROLE,
      model: "claude-opus-5-5",
      maxTurns: 30,
      maxBudgetUsd: 3,
      authMode: "subscription",
      resultSchema: "proposal-result",
      skills: [],
    });
    expect(role.schema).toBe(ProposalResult);
    expect([...role.tools].sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "WebFetch", "Write"]);
    expect(role.allow).toContain("WebFetch");
    const bash = role.allow.filter((rule) => rule.startsWith("Bash"));
    expect(bash.sort()).toEqual([
      "Bash(openspec instructions:*)",
      "Bash(openspec list:*)",
      "Bash(openspec show:*)",
      "Bash(openspec validate:*)",
    ]);
    expect(role.prompt).not.toMatch(/^---/);
    expect(role.prompt).toMatch(/untrusted/i);
  });

  it("may write proposal.md, delta specs and .openspec.yaml in its change folder", async () => {
    for (const path of [
      `${CHANGE}/proposal.md`,
      `${CHANGE}/specs/roles/spec.md`,
      `${CHANGE}/specs/vocab-import/spec.md`,
      `${CHANGE}/.openspec.yaml`,
    ]) {
      expect(await decide(path), path).toBeUndefined();
    }
  });

  it("may not write design.md, tasks.md or anything outside its change folder", async () => {
    for (const path of [
      `${CHANGE}/design.md`,
      `${CHANGE}/tasks.md`,
      `${CHANGE}/specs/roles/notes.md`,
      `${CHANGE}/specs/spec.md`,
      "openspec/changes/add-other/proposal.md",
      "openspec/changes/add-other/specs/roles/spec.md",
      "openspec/specs/roles/spec.md",
      "openspec/config.yaml",
      "package.json",
      `${CHANGE}/../add-other/proposal.md`,
    ]) {
      expect(await decide(path), path).toBe("deny");
    }
  });
});
