import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadGuard } from "../src/guard.ts";

const ROLE = "proposal-author";
const OUTSIDE_CONTENT = "outside-file-content";

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
  return createReadGuard({ role: ROLE, worktree })(input, "tool-use", { signal: new AbortController().signal });
}

const read = (filePath: string) => guard("Read", { file_path: filePath });
const grep = (path?: string) => guard("Grep", { pattern: "x", ...(path === undefined ? {} : { path }) });
const glob = (path?: string) => guard("Glob", { pattern: "**/*.md", ...(path === undefined ? {} : { path }) });

function specific(output: HookJSONOutput): { decision?: string | undefined; reason?: string | undefined } {
  const hook = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
  return hook?.hookEventName === "PreToolUse" ? { decision: hook.permissionDecision, reason: hook.permissionDecisionReason } : {};
}

// An allowed call must defer to the permission rules, never return "allow", which would bypass dontAsk.
async function expectNotDenied(output: Promise<HookJSONOutput>): Promise<void> {
  expect(specific(await output).decision).toBeUndefined();
}

async function expectDenied(output: Promise<HookJSONOutput>): Promise<void> {
  const { decision, reason } = specific(await output);
  expect(decision).toBe("deny");
  expect(reason).toBeTruthy();
}

beforeEach(() => {
  // realpath: the temp dir may itself sit behind a symlink.
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "vocab-read-guard-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "vocab-read-guard-outside-")));
  mkdirSync(join(worktree, "docs"));
  writeFileSync(join(worktree, "docs/brief.md"), "brief\n");
  writeFileSync(join(outside, "target.md"), `${OUTSIDE_CONTENT}\n`);
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("createReadGuard", () => {
  it("Scenario: Reading a process environment is denied", async () => {
    for (const path of ["/proc/self/environ", `/proc/${String(process.pid)}/environ`, `/proc/${String(process.ppid)}/environ`, "/proc/1/environ"]) {
      await expectDenied(read(path));
    }
    const { reason } = specific(await read("/proc/self/environ"));
    expect(reason).toContain("/proc/self/environ");
    await expectDenied(read("../../../../../../../../proc/self/environ"));
    await expectDenied(grep("/proc/self"));
    await expectDenied(glob("/proc"));
  });

  it("Scenario: Read through a symlink out of the worktree is denied", async () => {
    symlinkSync(join(outside, "target.md"), join(worktree, "docs/link.md"));
    const output = await read("docs/link.md");
    expect(specific(output).decision).toBe("deny");
    expect(JSON.stringify(output)).not.toContain(OUTSIDE_CONTENT);
    await expectDenied(read(join(worktree, "docs/link.md")));

    symlinkSync(outside, join(worktree, "escape"));
    await expectDenied(read("escape/target.md"));
    await expectDenied(grep("escape"));
    await expectDenied(glob("escape"));

    // A dangling symlink's eventual target cannot be checked.
    symlinkSync(join(outside, "not-there-yet.md"), join(worktree, "docs/dangling.md"));
    await expectDenied(read("docs/dangling.md"));
  });

  it("Scenario: Reading inside the worktree is allowed", async () => {
    await expectNotDenied(read("docs/brief.md"));
    await expectNotDenied(read(join(worktree, "docs/brief.md")));
    await expectNotDenied(grep(worktree));
    await expectNotDenied(glob(worktree));
  });

  it("leaves a missing file inside the worktree to the Read tool", async () => {
    await expectNotDenied(read("docs/missing.md"));
  });

  it("allows a symlink that stays inside the worktree", async () => {
    symlinkSync(join(worktree, "docs/brief.md"), join(worktree, "brief-link.md"));
    await expectNotDenied(read("brief-link.md"));
  });

  it("denies a path outside the worktree, including a sibling that shares its prefix", async () => {
    await expectDenied(read(join(outside, "target.md")));
    await expectDenied(read("../outside.md"));
    await expectDenied(read(`${worktree}-sibling/target.md`));
  });

  it("denies a Read with no file_path", async () => {
    await expectDenied(guard("Read", {}));
  });

  describe("Grep and Glob", () => {
    it("default to the worktree when they have no path", async () => {
      await expectNotDenied(grep());
      await expectNotDenied(glob());
    });

    it("allow a path inside the worktree, relative or absolute, including its root", async () => {
      for (const path of ["docs", ".", join(worktree, "docs"), worktree]) {
        await expectNotDenied(grep(path));
        await expectNotDenied(glob(path));
      }
    });

    it("deny a Glob pattern that is absolute, starts at the home directory or uses a .. segment, with or without path", async () => {
      for (const pattern of ["/proc/*/environ", join(worktree, "docs/*.md"), "~/**", "../**", "docs/../../**", "{/proc,docs}/*", "{..,docs}/*"]) {
        await expectDenied(guard("Glob", { pattern }));
        await expectDenied(guard("Glob", { pattern, path: "docs" }));
      }
    });

    it("allow a relative Glob pattern, including one whose name merely contains dots", async () => {
      for (const pattern of ["**/*.md", "docs/*.md", "{docs,src}/*", "docs/..hidden", "a..b/*"]) {
        await expectNotDenied(guard("Glob", { pattern }));
      }
    });

    it("deny a path outside the worktree, absolute or by traversal", async () => {
      for (const path of [outside, "/etc", "..", "docs/../.."]) {
        await expectDenied(grep(path));
        await expectDenied(glob(path));
      }
    });
  });
});
