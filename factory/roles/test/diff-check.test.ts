// The runner's boundaries for Bash roles (add-build-roles task 2.6): a fake session acts on a
// temp git repo as Bash or agent-run code would, and the diff check against the starting commit
// catches every write outside the role's globs.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HookJSONOutput, Options } from "@anthropic-ai/claude-agent-sdk";
import { ImplementationResult, TestResult } from "@vocab/factory-artifacts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writableFor, type Role } from "../src/config.ts";
import { diffCheck, diffPatch } from "../src/diff-check.ts";
import { createRunner, type Recorder, type WorkItem } from "../src/runner.ts";
import { fakeQuery, success } from "./fake-session.ts";

const CHANGE_ID = "add-sample";
const CHANGE = `openspec/changes/${CHANGE_ID}`;
const SOURCE = "app/domain/src/word.ts";
const TEST = "app/domain/test/word.test.ts";
const STUB = "app/domain/src/lemma.ts";
const ORIGINAL_TEST = 'it("Scenario: Words are counted", () => {});\n';

const BASH_ALLOW = ["Bash(pnpm typecheck)", "Bash(pnpm lint)", "Bash(pnpm exec vitest run:*)", "Bash(git status:*)", "Bash(git diff:*)"];
const IMPLEMENTER_GLOBS = ["app/*/src/**", "!app/contracts/**", "infra/app-stack.ts", "infra/preview-stack.ts", "infra/app/**"];
const TEST_AUTHOR_GLOBS = ["app/*/test/**", "app/e2e/**", "{taskStubs}"];

const ENV = { HOME: "/home/factory", PATH: "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" };

let repo: string;
let base: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** A sparse file just over the 10 MB limit, such as the core dump an aborted process leaves. */
function oversized(path: string): void {
  write(path, "");
  truncateSync(join(repo, path), 10 * 1024 * 1024 + 1);
}

function read(path: string): string {
  return readFileSync(join(repo, path), "utf8");
}

function buildRole(name: string, writable: string[]): Role {
  const testAuthor = name === "test-author";
  return {
    name,
    model: "claude-sonnet-5-5",
    runsIn: "build",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    allow: ["Read", "Grep", "Glob", "Edit", "Write", ...BASH_ALLOW],
    writable,
    skills: [],
    maxTurns: 5,
    maxBudgetUsd: 0.1,
    resultSchema: testAuthor ? "test-result" : "implementation-result",
    authMode: "subscription",
    prompt: `You are the ${name}.`,
    schema: testAuthor ? TestResult : ImplementationResult,
  };
}

const implementer = buildRole("implementer", IMPLEMENTER_GLOBS);
const testAuthor = buildRole("test-author", TEST_AUTHOR_GLOBS);
const IMPLEMENTED: ImplementationResult = { summary: "Counted the words.", notes: "" };
const TESTED: TestResult = { tests: [{ file: TEST, scenario: "Words are counted" }], stubs: [STUB], notes: "" };

const recorder: Recorder = { record: () => Promise.resolve() };

function item(taskStubs: string[] = []): WorkItem {
  return { id: "item-1", changeId: CHANGE_ID, worktree: repo, issue: { title: "", body: "" }, changeFiles: [], specs: [], taskStubs, prompt: "Build task 1.1." };
}

/** Runs the role in the build container against a fake session that runs `act` mid-session. */
async function session(role: Role, act: (options: Options) => void | Promise<void>, taskStubs: string[] = []) {
  const output = role.name === "test-author" ? TESTED : IMPLEMENTED;
  const fake = fakeQuery(success(output), act);
  const runRole = createRunner({ query: fake.query, recorder, env: ENV, container: "build" });
  const result = await runRole(role, item(taskStubs));
  return { result, options: fake.calls[0]?.options };
}

/** The role's path guard, as the runner hooked it onto Edit, Write and NotebookEdit. */
async function pathGuardDecision(options: Options | undefined, filePath: string): Promise<{ decision?: string | undefined; reason?: string | undefined }> {
  const hook = (options?.hooks?.PreToolUse ?? []).find((entry) => entry.matcher === "Edit|Write|NotebookEdit")?.hooks[0];
  if (hook === undefined) throw new Error("no path guard hooked");
  const output: HookJSONOutput = await hook(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      transcript_path: join(repo, "transcript.jsonl"),
      cwd: repo,
      tool_name: "Write",
      tool_input: { file_path: filePath, content: "changed\n" },
      tool_use_id: "toolu_1",
    },
    "toolu_1",
    { signal: new AbortController().signal },
  );
  const specific = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
  return specific?.hookEventName === "PreToolUse" ? { decision: specific.permissionDecision, reason: specific.permissionDecisionReason } : {};
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "vocab-diff-check-")));
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "factory@example.invalid");
  git("config", "user.name", "factory");
  git("config", "commit.gpgsign", "false");
  write(".gitignore", "node_modules/\n");
  write(SOURCE, "export const words = 0;\n");
  write(TEST, ORIGINAL_TEST);
  write("app/contracts/src/word.ts", "export type Word = string;\n");
  write("package.json", '{ "name": "sample" }\n');
  // A valid change, so the runner's own `openspec validate` passes.
  write(`${CHANGE}/proposal.md`, "# Proposal\n\n## Why\n\nA sample change for the diff check tests, long enough for strict validation.\n\n## What Changes\n\n- A sample requirement.\n");
  write(
    `${CHANGE}/specs/roles/spec.md`,
    "## ADDED Requirements\n\n### Requirement: Sample behaviour\nThe system SHALL do the sample thing.\n\n#### Scenario: Sample works\n- **WHEN** the sample runs\n- **THEN** it works\n",
  );
  git("add", "--all");
  git("commit", "--quiet", "--message", "base");
  base = git("rev-parse", "HEAD");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("the diff check of a build role's session", () => {
  it("Scenario: Bash write outside the role's paths fails the attempt", async () => {
    // As `pnpm exec vitest run` running agent code would: no guarded tool is involved.
    const { result } = await session(implementer, () => {
      write(SOURCE, "export const words = 1;\n");
      write(TEST, 'it("Scenario: Words are counted", () => { expect(true).toBe(true); });\n');
    });
    // The session itself succeeded: only the check after it can catch the write.
    expect(result).toEqual(IMPLEMENTED);

    const check = await diffCheck(repo, base, writableFor(implementer, CHANGE_ID));
    expect(check).toEqual({ passed: false, outside: [TEST] });
  });

  it("Scenario: Commit made during the session is still checked", async () => {
    await session(implementer, () => {
      write(TEST, "// rewritten\n");
      git("add", "--all");
      git("commit", "--quiet", "--message", "hide the test change");
    });
    // Control: compared with HEAD, as `git status` does, the change is invisible.
    expect(git("status", "--porcelain")).toBe("");

    const check = await diffCheck(repo, base, writableFor(implementer, CHANGE_ID));
    expect(check).toEqual({ passed: false, outside: [TEST] });
  });

  it("Scenario: Ignored caches pass the diff check", async () => {
    await session(implementer, () => {
      write("node_modules/.vite/vitest/results.json", '{"version":"5.0.5","results":[]}\n');
      write(SOURCE, "export const words = 1;\n");
    });

    expect(await diffCheck(repo, base, writableFor(implementer, CHANGE_ID))).toEqual({ passed: true, outside: [] });
  });

  it("Scenario: Oversized file fails the diff check", async () => {
    await session(testAuthor, () => {
      write("app/domain/test/lemma.test.ts", 'it("Scenario: Lemmas are found", () => { expect(1).toBe(2); });\n');
      oversized("app/domain/test/huge.bin");
      oversized("core.812");
    });

    expect(await diffCheck(repo, base, writableFor(testAuthor, CHANGE_ID))).toEqual({ passed: false, outside: ["app/domain/test/huge.bin", "core.812"] });
    const patch = await diffPatch(repo, base);
    expect(patch).toContain("app/domain/test/lemma.test.ts");
    expect(patch).not.toContain("huge.bin");
    expect(patch).not.toContain("core.812");
  });

  it("Scenario: Test author cannot change existing code", async () => {
    const { options } = await session(
      testAuthor,
      () => {
        write(STUB, 'export function lemma(_word: string): string {\n  throw new Error("not implemented");\n}\n');
        write(TEST, 'it("Scenario: Words are counted", () => { expect(1).toBe(2); });\n');
        // Through Bash: the existing source file.
        write(SOURCE, "export const words = 2;\n");
      },
      [STUB],
    );

    // Through the guarded tools the call is denied; the task's new file is allowed (control).
    expect((await pathGuardDecision(options, SOURCE)).decision).toBe("deny");
    expect((await pathGuardDecision(options, STUB)).decision).toBeUndefined();
    expect((await pathGuardDecision(options, TEST)).decision).toBeUndefined();

    const check = await diffCheck(repo, base, writableFor(testAuthor, CHANGE_ID, [STUB]), [STUB]);
    expect(check).toEqual({ passed: false, outside: [SOURCE] });
  });

  it("Scenario: Implementer cannot edit a test", async () => {
    const { options } = await session(implementer, () => undefined);

    const denied = await pathGuardDecision(options, TEST);
    expect(denied.decision).toBe("deny");
    for (const glob of IMPLEMENTER_GLOBS) expect(denied.reason).toContain(glob);
    expect(read(TEST)).toBe(ORIGINAL_TEST);
  });

  it("fails a {taskStubs} file that already existed at the starting commit, and passes a new one", async () => {
    const existing = await diffCheck(repo, base, writableFor(testAuthor, CHANGE_ID, [SOURCE]), [SOURCE]);
    // Nothing changed yet: an untouched existing stub path is no write at all.
    expect(existing).toEqual({ passed: true, outside: [] });

    write(SOURCE, "export const words = 3;\n");
    write(STUB, "export {};\n");
    const check = await diffCheck(repo, base, writableFor(testAuthor, CHANGE_ID, [SOURCE, STUB]), [SOURCE, STUB]);
    expect(check).toEqual({ passed: false, outside: [SOURCE] });
  });
});

describe("diffCheck", () => {
  it("passes when nothing changed", async () => {
    expect(await diffCheck(repo, base, IMPLEMENTER_GLOBS)).toEqual({ passed: true, outside: [] });
  });

  it("counts staged, unstaged and untracked changes alike, and lists each outside path once, sorted", async () => {
    write("package.json", '{ "name": "changed" }\n');
    git("add", "package.json");
    write("package.json", '{ "name": "changed again" }\n');
    write("app/contracts/src/new.ts", "export {};\n");
    write("README.md", "new\n");
    write(SOURCE, "export const words = 4;\n");

    expect(await diffCheck(repo, base, IMPLEMENTER_GLOBS)).toEqual({ passed: false, outside: ["README.md", "app/contracts/src/new.ts", "package.json"] });
  });

  it("counts a deletion, and a rename as a deletion and an addition", async () => {
    unlinkSync(join(repo, TEST));
    git("mv", SOURCE, "app/domain/test/moved.ts");

    expect(await diffCheck(repo, base, IMPLEMENTER_GLOBS)).toEqual({ passed: false, outside: ["app/domain/test/moved.ts", TEST] });
  });

  it("catches a change to .gitignore that would hide a file", async () => {
    write(".gitignore", "node_modules/\napp/domain/test/\n");
    write("app/domain/test/hidden.test.ts", "// hidden\n");

    const check = await diffCheck(repo, base, IMPLEMENTER_GLOBS);
    expect(check.passed).toBe(false);
    expect(check.outside).toContain(".gitignore");
  });

  it("handles paths with spaces, quotes and non-ASCII names", async () => {
    write("app/domain/test/wörter \"neu\".test.ts", "// new\n");
    write("app/domain/src/größe.ts", "export {};\n");

    expect(await diffCheck(repo, base, IMPLEMENTER_GLOBS)).toEqual({ passed: false, outside: ['app/domain/test/wörter "neu".test.ts'] });
  });

  it("compares with the given commit, never with HEAD", async () => {
    write(TEST, "// committed earlier\n");
    git("commit", "--quiet", "--all", "--message", "a later commit");

    expect(await diffCheck(repo, git("rev-parse", "HEAD"), IMPLEMENTER_GLOBS)).toEqual({ passed: true, outside: [] });
    expect(await diffCheck(repo, base, IMPLEMENTER_GLOBS)).toEqual({ passed: false, outside: [TEST] });
  });

  it("rejects a base that is not a commit of the repository", async () => {
    await expect(diffCheck(repo, "0".repeat(40), IMPLEMENTER_GLOBS)).rejects.toThrow();
  });
});

describe("diffPatch", () => {
  it("holds committed, staged, unstaged and untracked changes, and applies cleanly to the base commit", async () => {
    write(SOURCE, "export const words = 5;\n");
    git("commit", "--quiet", "--all", "--message", "committed");
    write("app/domain/src/staged.ts", "export const staged = true;\n");
    git("add", "app/domain/src/staged.ts");
    write("app/domain/src/untracked.ts", "export const untracked = true;\n");
    unlinkSync(join(repo, "app/contracts/src/word.ts"));
    write("node_modules/cache.json", "{}\n");

    const patch = await diffPatch(repo, base);

    const fresh = realpathSync(mkdtempSync(join(tmpdir(), "vocab-diff-apply-")));
    try {
      execFileSync("git", ["clone", "--quiet", repo, fresh]);
      execFileSync("git", ["checkout", "--quiet", "--detach", base], { cwd: fresh });
      execFileSync("git", ["apply", "--index", "-"], { cwd: fresh, input: patch });
      const changed = execFileSync("git", ["diff", "--cached", "--name-status", "--no-renames", base], { cwd: fresh, encoding: "utf8" }).trim().split("\n").sort();
      expect(changed).toEqual(["A\tapp/domain/src/staged.ts", "A\tapp/domain/src/untracked.ts", "D\tapp/contracts/src/word.ts", `M\t${SOURCE}`]);
      expect(readFileSync(join(fresh, SOURCE), "utf8")).toBe("export const words = 5;\n");
      expect(readFileSync(join(fresh, "app/domain/src/untracked.ts"), "utf8")).toBe("export const untracked = true;\n");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("is empty when nothing changed", async () => {
    expect(await diffPatch(repo, base)).toBe("");
  });
});
