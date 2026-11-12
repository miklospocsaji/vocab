import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HookJSONOutput, Options, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { ProposalResult } from "@vocab/factory-artifacts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRole, writableFor } from "../src/config.ts";
import { createPathGuard } from "../src/guard.ts";
import { AttemptFailed, createRunner, type QueryFn } from "../src/runner.ts";

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
  it("loads with its model, limits and result schema", async () => {
    const role = await loadRole(ROLE);
    expect(role).toMatchObject({
      name: ROLE,
      model: "claude-opus-5-5",
      runsIn: "worker",
      maxTurns: 30,
      maxBudgetUsd: 1.5,
      authMode: "subscription",
      resultSchema: "proposal-result",
      skills: [],
    });
    expect(role.schema).toBe(ProposalResult);
    expect(role.prompt).not.toMatch(/^---/);
    expect(role.prompt).toMatch(/untrusted/i);
  });

  it("allows WebFetch only with the two GitHub domain rules", async () => {
    const role = await loadRole(ROLE);
    expect(role.tools).toContain("WebFetch");
    expect(role.allow.filter((rule) => rule.startsWith("WebFetch")).sort()).toEqual([
      "WebFetch(domain:github.com)",
      "WebFetch(domain:raw.githubusercontent.com)",
    ]);
  });

  it("Scenario: Proposal author cannot run commands", async () => {
    const role = await loadRole(ROLE);
    expect([...role.tools].sort()).toEqual(["Edit", "Glob", "Grep", "Read", "WebFetch", "Write"]);

    // The session the runner actually starts, not only the config it reads.
    let options: Options | undefined;
    const query: QueryFn = (params) => {
      options = params.options;
      return (async function* () {})();
    };
    const runRole = createRunner({ query, recorder: { record: () => Promise.resolve() }, env: { PATH: "/usr/bin" } });
    const item = { id: "item-1", changeId: CHANGE_ID, worktree, issue: { title: "Add a sample", body: "Please add a sample." }, changeFiles: [], specs: [] };
    await expect(runRole(role, item)).rejects.toBeInstanceOf(AttemptFailed);

    expect(options?.tools).toBeDefined();
    expect(options?.tools).not.toContain("Bash");
    expect(options?.allowedTools?.filter((rule) => rule.startsWith("Bash"))).toEqual([]);
  });

  it("has a prompt, without frontmatter, that neither offers Bash nor tells the role to run openspec", async () => {
    const role = await loadRole(ROLE);
    const file = readFileSync(resolve(import.meta.dirname, "..", `${ROLE}.md`), "utf8");
    expect(file).not.toMatch(/^\s*---/);
    expect(file).not.toMatch(/\bBash\b/);
    expect(role.prompt).toBe(file.trim());
    expect(role.prompt).not.toMatch(/\b[Rr]un `openspec/);
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
