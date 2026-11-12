// `factory-build <role> --input <key>` (add-build-roles task 2.10), with a fake role runner,
// fake gates and install, a temp git remote and an FsStore.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BuildOutcome, GatesResult, ImplementationResult, TestResult } from "@vocab/factory-artifacts";
import type { RunGatesOptions } from "@vocab/factory-gates";
import { AttemptFailed, type Recorder, type Role, type RunRole, type WorkItem } from "@vocab/factory-roles";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_EXIT, FACTORY_CREDENTIALS, runBuild, type BuildDeps, type BuildInput } from "../src/build.ts";
import { FsStore, type ArtifactStore } from "../src/store.ts";

const CHANGE_ID = "add-sample";
const SOURCE = "app/domain/src/word.ts";
const TEST = "app/domain/test/word.test.ts";
const STUB = "app/domain/src/lemma.ts";
const TOKEN = `oauth-token-${randomUUID()}`;
const PREFIX = (role: string) => `work-items/${CHANGE_ID}/tasks/1.1/${role}/1`;
const INPUT_KEY = (role: string) => `${PREFIX(role)}/input.json`;

const IMPLEMENTED: ImplementationResult = { summary: "Counted the words.", notes: "" };
const TESTED: TestResult = { tests: [{ file: TEST, scenario: "Words are counted" }], stubs: [STUB], notes: "" };

function role(name: string, overrides: Partial<Role> = {}): Role {
  const testAuthor = name === "test-author";
  return {
    name,
    model: "claude-sonnet-5-5",
    runsIn: "build",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    allow: ["Read", "Bash(pnpm exec vitest run:*)"],
    writable: testAuthor ? ["app/*/test/**", "app/e2e/**", "{taskStubs}"] : ["app/*/src/**", "!app/contracts/**"],
    skills: [],
    maxTurns: 5,
    maxBudgetUsd: 0.1,
    resultSchema: testAuthor ? "test-result" : "implementation-result",
    authMode: "subscription",
    prompt: `You are the ${name}.`,
    schema: testAuthor ? TestResult : ImplementationResult,
    ...overrides,
  };
}

const ROLES: Record<string, Role> = {
  implementer: role("implementer"),
  "test-author": role("test-author"),
  "proposal-author": role("proposal-author", { runsIn: "worker", tools: ["Read"], allow: ["Read"] }),
};

let work: string;
let remote: string;
let base: string;
let storeRoot: string;
let store: FsStore;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function message(type: "init" | "result"): SDKMessage {
  return (type === "init"
    ? { type: "system", subtype: "init", apiKeySource: "none", session_id: "s", uuid: randomUUID() }
    : { type: "result", subtype: "success", total_cost_usd: 0.01, session_id: "s", uuid: randomUUID() }) as unknown as SDKMessage;
}

interface Fake {
  deps: BuildDeps;
  runners: { container: "worker" | "build" }[];
  sessions: { role: Role; item: WorkItem; head: string }[];
  gates: RunGatesOptions[];
  installs: string[];
  out: string[];
  err: string[];
  reads: string[];
}

interface FakeOptions {
  env?: Record<string, string | undefined>;
  /** What the session does to the clone. */
  act?: (worktree: string) => void;
  /** The session's outcome: its result, or an error to throw. */
  outcome?: unknown;
  gatesPass?: boolean;
}

function fake(options: FakeOptions = {}): Fake {
  const runners: Fake["runners"] = [];
  const sessions: Fake["sessions"] = [];
  const gates: Fake["gates"] = [];
  const installs: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const reads: string[] = [];
  const counting: ArtifactStore = {
    get: (key) => {
      reads.push(key);
      return store.get(key);
    },
    put: (key, body) => store.put(key, body),
    exists: (key) => store.exists(key),
  };
  const createRunRole = ({ recorder, container }: { recorder: Recorder; container: "worker" | "build" }): RunRole => {
    runners.push({ container });
    return async (sessionRole, item) => {
      sessions.push({ role: sessionRole, item, head: git(item.worktree, "rev-parse", "HEAD") });
      await recorder.record(item.id, sessionRole.name, message("init"));
      options.act?.(item.worktree);
      await recorder.record(item.id, sessionRole.name, message("result"));
      if (options.outcome instanceof Error) throw options.outcome;
      return options.outcome ?? (sessionRole.name === "test-author" ? TESTED : IMPLEMENTED);
    };
  };
  const deps: BuildDeps = {
    env: options.env ?? { FACTORY_CONTAINER: "build", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, HOME: home, PATH: process.env["PATH"] },
    store: counting,
    home,
    createRunRole,
    loadRole: (name) => {
      const found = ROLES[name];
      return found === undefined ? Promise.reject(new Error(`no role ${name}`)) : Promise.resolve(found);
    },
    install: (worktree) => {
      installs.push(worktree);
      return Promise.resolve();
    },
    runGates: (gateOptions) => {
      gates.push(gateOptions);
      return Promise.resolve({ mode: gateOptions.mode, changeId: gateOptions.changeId, taskId: gateOptions.task.id, passed: options.gatesPass ?? true, checks: [] });
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { deps, runners, sessions, gates, installs, out, err, reads };
}

function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    changeId: CHANGE_ID,
    branch: CHANGE_ID,
    baseCommit: base,
    cloneUrl: remote,
    task: { id: "1.1", title: "Count the words", dependsOn: [], files: [SOURCE, STUB], scenarios: ["Words are counted"], tests: [TEST] },
    coveredSoFar: ["Words are counted"],
    ...overrides,
  };
}

async function build(roleName: string, options: FakeOptions = {}, buildInput: unknown = input()): Promise<Fake & { code: number }> {
  await store.put(INPUT_KEY(roleName), JSON.stringify(buildInput));
  const f = fake(options);
  const code = await runBuild([roleName, "--input", INPUT_KEY(roleName)], f.deps);
  return { ...f, code };
}

async function outcome(roleName: string): Promise<BuildOutcome> {
  return BuildOutcome.parse(JSON.parse(await store.get(`${PREFIX(roleName)}/outcome.json`)));
}

beforeEach(() => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "vocab-build-")));
  work = join(tmp, "work");
  remote = join(tmp, "remote.git");
  storeRoot = join(tmp, "store");
  home = join(tmp, "home");
  mkdirSync(work);
  mkdirSync(home);
  git(work, "init", "--quiet", "--initial-branch", CHANGE_ID);
  git(work, "config", "user.email", "factory@example.invalid");
  git(work, "config", "user.name", "factory");
  git(work, "config", "commit.gpgsign", "false");
  write(work, ".gitignore", "node_modules/\n");
  write(work, SOURCE, "export const words = 0;\n");
  write(work, TEST, 'it("Scenario: Words are counted", () => {});\n');
  write(work, "app/domain/src/old.ts", "export const old = true;\n");
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "--message", "base");
  base = git(work, "rev-parse", "HEAD");
  // A later commit on the branch: the build must start from `baseCommit`, not the branch tip.
  write(work, "app/domain/src/later.ts", "export const later = true;\n");
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "--message", "later");
  execFileSync("git", ["clone", "--quiet", "--bare", work, remote]);
  store = new FsStore(storeRoot);
});

afterEach(() => {
  rmSync(dirname(work), { recursive: true, force: true });
});

describe("factory-build", () => {
  it.each(["FACTORY_GITHUB_APP_PRIVATE_KEY", "FACTORY_LEDGER_SECRET"])("Scenario: Build container refuses factory credentials (%s)", async (name) => {
    const value = `secret-value-${randomUUID()}`;
    const result = await build("implementer", { env: { FACTORY_CONTAINER: "build", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, HOME: home, [name]: value } });

    expect(result.code).toBe(BUILD_EXIT.invalid);
    expect(result.err.join("")).toContain(name);
    expect([...result.err, ...result.out].join("")).not.toContain(value);
    // Before reading the input, cloning or starting a session.
    expect(result.reads).toEqual([]);
    expect(existsSync(join(home, "work"))).toBe(false);
    expect(result.runners).toEqual([]);
    expect(await store.exists(`${PREFIX("implementer")}/outcome.json`)).toBe(false);
  });

  it("refuses every other factory credential, even when empty", async () => {
    for (const name of FACTORY_CREDENTIALS) {
      const result = await build("implementer", { env: { FACTORY_CONTAINER: "build", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, [name]: "" } });
      expect(result.code, name).toBe(BUILD_EXIT.invalid);
      expect(result.err.join(""), name).toContain(name);
      expect(result.runners, name).toEqual([]);
    }
  });

  it("runs the implementer from the base commit, then the green gates, and writes a passed outcome next to the input", async () => {
    const result = await build("implementer", {
      act: (worktree) => {
        write(worktree, SOURCE, "export const words = 1;\n");
      },
    });

    expect(result.err.join("")).toBe("");
    expect(result.code).toBe(BUILD_EXIT.ok);
    expect(result.runners).toEqual([{ container: "build" }]);
    expect(result.installs).toEqual([join(home, "work")]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.head).toBe(base);
    expect(result.sessions[0]?.item.worktree).toBe(join(home, "work"));
    expect(result.sessions[0]?.item.prompt).toContain("Count the words");

    expect(result.gates).toHaveLength(1);
    expect(result.gates[0]).toMatchObject({
      worktree: join(home, "work"),
      changeId: CHANGE_ID,
      mode: "green",
      task: { id: "1.1", scenarios: ["Words are counted"], coveredSoFar: ["Words are counted"] },
    });
    expect(result.gates[0]?.secrets).toContain(TOKEN);

    expect(await outcome("implementer")).toEqual({
      role: "implementer",
      outcome: "passed",
      roleResult: IMPLEMENTED,
      diffCheck: { passed: true, outside: [] },
      gates: `${PREFIX("implementer")}/gates.json`,
      patch: `${PREFIX("implementer")}/patch.diff`,
      messages: `${PREFIX("implementer")}/messages.jsonl`,
      baseCommit: base,
    });
    expect(GatesResult.parse(JSON.parse(await store.get(`${PREFIX("implementer")}/gates.json`)))).toMatchObject({ mode: "green", passed: true });
    expect([...result.out, ...result.err].join("")).not.toContain(TOKEN);
  });

  it("runs the test author with the task's new files as stubs, then the red gates", async () => {
    const result = await build("test-author", {
      act: (worktree) => {
        write(worktree, STUB, "export {};\n");
      },
    });

    expect(result.code).toBe(BUILD_EXIT.ok);
    expect(result.sessions[0]?.item.taskStubs).toEqual([STUB]);
    expect(result.gates[0]?.mode).toBe("red");
    expect(await outcome("test-author")).toMatchObject({ outcome: "passed", roleResult: TESTED, diffCheck: { passed: true, outside: [] } });
  });

  it("writes a failed outcome when the session fails, with no gates run", async () => {
    const result = await build("implementer", {
      act: (worktree) => {
        write(worktree, SOURCE, "export const words = 9;\n");
      },
      outcome: new AttemptFailed("max-turns", "error_max_turns"),
    });

    expect(result.code).toBe(BUILD_EXIT.ok);
    expect(result.gates).toEqual([]);
    const written = await outcome("implementer");
    expect(written).toMatchObject({ outcome: "failed", reason: "max-turns", diffCheck: { passed: true, outside: [] } });
    expect(written.gates).toBeUndefined();
    expect(written.roleResult).toBeUndefined();
    expect(await store.exists(`${PREFIX("implementer")}/gates.json`)).toBe(false);
    expect(await store.exists(written.patch)).toBe(true);
    expect(await store.exists(written.messages)).toBe(true);
  });

  it("writes a failed outcome when the diff check fails, with no gates run", async () => {
    const result = await build("implementer", {
      act: (worktree) => {
        write(worktree, TEST, "// rewritten by the implementer\n");
      },
    });

    expect(result.code).toBe(BUILD_EXIT.ok);
    expect(result.gates).toEqual([]);
    const written = await outcome("implementer");
    expect(written).toMatchObject({ outcome: "failed", reason: "diff-check", diffCheck: { passed: false, outside: [TEST] } });
    expect(written.gates).toBeUndefined();
  });

  it.each([
    ["implementer", "green"],
    ["test-author", "red"],
  ] as const)("writes a failed outcome with reason %s's gate when the gates fail", async (roleName, reason) => {
    const result = await build(roleName, { gatesPass: false });

    expect(result.code).toBe(BUILD_EXIT.ok);
    const written = await outcome(roleName);
    expect(written).toMatchObject({ outcome: "failed", reason, gates: `${PREFIX(roleName)}/gates.json` });
  });

  it("writes a patch that applies cleanly to the base commit", async () => {
    await build("implementer", {
      act: (worktree) => {
        write(worktree, SOURCE, "export const words = 7;\n");
        write(worktree, "app/domain/src/count.ts", "export const count = 7;\n");
        unlinkSync(join(worktree, "app/domain/src/old.ts"));
        write(worktree, "node_modules/.vite/results.json", "{}\n");
      },
    });
    const patch = await store.get((await outcome("implementer")).patch);

    const fresh = join(dirname(work), "fresh");
    execFileSync("git", ["clone", "--quiet", remote, fresh]);
    git(fresh, "checkout", "--quiet", "--detach", base);
    execFileSync("git", ["apply", "--index", "-"], { cwd: fresh, input: patch });
    expect(git(fresh, "diff", "--cached", "--name-status", "--no-renames", base).split("\n").sort()).toEqual([
      "A\tapp/domain/src/count.ts",
      "D\tapp/domain/src/old.ts",
      `M\t${SOURCE}`,
    ]);
    expect(readFileSync(join(fresh, SOURCE), "utf8")).toBe("export const words = 7;\n");
  });

  it("writes the session's messages to messages.jsonl, one per line", async () => {
    await build("implementer");
    const jsonl = await store.get((await outcome("implementer")).messages);
    expect(jsonl.trimEnd().split("\n").map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(["system", "result"]);
  });

  it("asks for the worker's runner when FACTORY_CONTAINER is not build", async () => {
    const result = await build("implementer", { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, HOME: home } });
    expect(result.runners).toEqual([{ container: "worker" }]);
  });

  it("exits 1 with no outcome when the session crashes", async () => {
    const result = await build("implementer", { outcome: new Error("spawn claude ENOENT") });

    expect(result.code).toBe(BUILD_EXIT.error);
    expect(result.err.join("")).toContain("spawn claude ENOENT");
    expect(await store.exists(`${PREFIX("implementer")}/outcome.json`)).toBe(false);
  });

  it("refuses a role that runs in the worker with exit 2, before cloning", async () => {
    const result = await build("proposal-author");
    expect(result.code).toBe(BUILD_EXIT.invalid);
    expect(result.err.join("")).toContain("proposal-author");
    expect(existsSync(join(home, "work"))).toBe(false);
  });

  describe("bad input exits 2 with no outcome", () => {
    it.each([
      ["no arguments", []],
      ["no --input", ["implementer"]],
      ["an extra argument", ["implementer", "extra", "--input", INPUT_KEY("implementer")]],
      ["an unknown option", ["implementer", "--input", INPUT_KEY("implementer"), "--force"]],
      ["a missing input key", ["implementer", "--input", `${PREFIX("implementer")}/missing.json`]],
      ["a key with ..", ["implementer", "--input", "work-items/../input.json"]],
    ])("%s", async (_label, argv) => {
      await store.put(INPUT_KEY("implementer"), JSON.stringify(input()));
      const f = fake();
      expect(await runBuild(argv, f.deps)).toBe(BUILD_EXIT.invalid);
      expect(f.err.join("")).not.toBe("");
      expect(f.runners).toEqual([]);
      expect(await store.exists(`${PREFIX("implementer")}/outcome.json`)).toBe(false);
    });

    it.each([
      ["input that is not JSON", "not json"],
      ["input that fails its schema", JSON.stringify({ ...input(), baseCommit: "HEAD" })],
    ])("%s", async (_label, body) => {
      await store.put(INPUT_KEY("implementer"), body);
      const f = fake();
      expect(await runBuild(["implementer", "--input", INPUT_KEY("implementer")], f.deps)).toBe(BUILD_EXIT.invalid);
      expect(f.runners).toEqual([]);
      expect(existsSync(join(home, "work"))).toBe(false);
    });
  });
});
