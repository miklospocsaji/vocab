import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPathGuard } from "../src/guard.ts";

const ROLE = "proposal-author";
const CHANGE = "openspec/changes/add-sample";
const WRITABLE = [`${CHANGE}/proposal.md`, `${CHANGE}/specs/**/spec.md`, `${CHANGE}/.openspec.yaml`, "notebooks/*.ipynb"];

let worktree: string;
let outside: string;

function guard(toolName: string, toolInput: Record<string, unknown>): Promise<HookJSONOutput> {
  const input: PreToolUseHookInput = {
    hook_event_name: "PreToolUse",
    session_id: "session",
    transcript_path: join(worktree, "transcript.jsonl"),
    cwd: worktree,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tool-use",
  };
  return createPathGuard({ role: ROLE, worktree, writable: WRITABLE })(input, "tool-use", { signal: new AbortController().signal });
}

const write = (filePath: string) => guard("Write", { file_path: filePath, content: "x" });

function decision(output: HookJSONOutput): string | undefined {
  const specific = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
  return specific?.hookEventName === "PreToolUse" ? specific.permissionDecision : undefined;
}

function reason(output: HookJSONOutput): string | undefined {
  const specific = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
  return specific?.hookEventName === "PreToolUse" ? specific.permissionDecisionReason : undefined;
}

// An allowed call must defer to the permission rules, never return "allow", which would bypass dontAsk.
async function expectAllowed(output: Promise<HookJSONOutput>): Promise<void> {
  expect(decision(await output)).toBeUndefined();
}

async function expectDenied(output: Promise<HookJSONOutput>): Promise<void> {
  expect(decision(await output)).toBe("deny");
}

beforeEach(() => {
  // realpath: the temp dir may itself sit behind a symlink.
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "vocab-guard-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "vocab-guard-outside-")));
  mkdirSync(join(worktree, CHANGE), { recursive: true });
  writeFileSync(join(worktree, "package.json"), "{}\n");
  writeFileSync(join(outside, "target.md"), "outside\n");
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("createPathGuard", () => {
  // Control: without it, a guard that denies everything would pass every scenario below.
  it("allows a write to an allowed path, relative or absolute", async () => {
    await expectAllowed(write(`${CHANGE}/proposal.md`));
    await expectAllowed(write(join(worktree, CHANGE, "proposal.md")));
  });

  it("Scenario: Write outside the allowed paths is denied", async () => {
    const output = await write(`${CHANGE}/design.md`);
    expect(decision(output)).toBe("deny");
    for (const glob of WRITABLE) expect(reason(output)).toContain(glob);
    await expectDenied(write(`${CHANGE}/tasks.md`));
    await expectDenied(write("package.json"));
  });

  it("Scenario: Path traversal is denied", async () => {
    await expectDenied(write(`${CHANGE}/../../../package.json`));
    await expectDenied(write(join(worktree, CHANGE, "../../../package.json")));
    // A traversal that leaves the worktree, yet lands on a path its globs would match.
    await expectDenied(write(`${CHANGE}/../../../../${CHANGE}/proposal.md`));
  });

  it("Scenario: Symlink escape is denied", async () => {
    // A directory symlink under an allowed glob, pointing outside the worktree.
    mkdirSync(join(worktree, CHANGE, "specs"), { recursive: true });
    symlinkSync(outside, join(worktree, CHANGE, "specs/escape"));
    await expectDenied(write(`${CHANGE}/specs/escape/spec.md`));
    // A directory symlink pointing inside the worktree, but outside the role's paths.
    mkdirSync(join(worktree, "src"));
    symlinkSync(join(worktree, "src"), join(worktree, CHANGE, "specs/inside"));
    await expectDenied(write(`${CHANGE}/specs/inside/spec.md`));
    // An allowed file name that is itself a symlink to a file outside the role's paths.
    symlinkSync(join(worktree, "package.json"), join(worktree, CHANGE, "proposal.md"));
    await expectDenied(write(`${CHANGE}/proposal.md`));
  });

  it("follows symlinks for a new file in a directory that does not exist yet", async () => {
    await expectAllowed(write(`${CHANGE}/specs/new-capability/spec.md`));
    mkdirSync(join(worktree, CHANGE, "specs"), { recursive: true });
    symlinkSync(outside, join(worktree, CHANGE, "specs/escape"));
    await expectDenied(write(`${CHANGE}/specs/escape/new-capability/spec.md`));
  });

  it("matches dotfiles", async () => {
    await expectAllowed(write(`${CHANGE}/.openspec.yaml`));
    await expectAllowed(write(`${CHANGE}/specs/.hidden/spec.md`));
    await expectDenied(write(".claude/settings.json"));
  });

  it("checks Edit's file_path", async () => {
    await expectAllowed(guard("Edit", { file_path: `${CHANGE}/proposal.md`, old_string: "a", new_string: "b" }));
    await expectDenied(guard("Edit", { file_path: `${CHANGE}/design.md`, old_string: "a", new_string: "b" }));
  });

  it("checks NotebookEdit's notebook_path", async () => {
    await expectAllowed(guard("NotebookEdit", { notebook_path: "notebooks/sample.ipynb", new_source: "x" }));
    await expectDenied(guard("NotebookEdit", { notebook_path: "sample.ipynb", new_source: "x" }));
    await expectDenied(guard("NotebookEdit", { notebook_path: join(outside, "sample.ipynb"), new_source: "x" }));
  });

  it("denies an absolute path outside the worktree", async () => {
    await expectDenied(write(join(outside, "target.md")));
  });

  it("denies a call with no target path", async () => {
    await expectDenied(guard("Write", { content: "x" }));
  });
});
