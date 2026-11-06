/**
 * The worker (add-factory-worker task 1.12): `runWorker` with a FakeForge on a temp bare
 * remote, the scripted fake role runner and the real ledger.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "@vocab/factory-forge";
import { FakeForge, type FakeIssue } from "@vocab/factory-forge/testing";
import { findWorkItemByIssue, LedgerRecorder, listAttempts } from "@vocab/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@vocab/factory-ledger/testing";
import { MISSING_REQUIREMENT_COMMENT } from "@vocab/factory-orchestrator";
import { loadRole, type Role } from "@vocab/factory-roles";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGE_FILES, createFakeRoleRunner, type FakeCall, type FakeStep } from "../../orchestrator/test/fake-role-runner.ts";
import { runWorker, WORKER_EXIT, type WorkerDeps, type WorkerIdentity } from "../src/worker.ts";

const CHANGE_ID = "add-import-kindle-vocab-db";
const ISSUE = { number: 12, title: "Import Kindle vocab.db", body: "Import the lookups from the Kindle's vocab.db." };
const EMPTY_ISSUE = { number: 13, title: "Something", body: "" };
const BOT: WorkerIdentity = { name: "vocab-factory[bot]", email: "41898282+vocab-factory[bot]@users.noreply.github.com" };

const VALID: FakeStep = {
  files: { "proposal.md": CHANGE_FILES.proposal, ".openspec.yaml": CHANGE_FILES.metadata, "specs/vocab-import/spec.md": CHANGE_FILES.spec },
};
const INVALID: FakeStep = { files: { "proposal.md": CHANGE_FILES.proposal } };

let db: TestDatabase;
let role: Role;
let root: string;
let remote: string;
let home: string;
let forge: FakeForge;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, file: string, content: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
}

function remoteBranches(): string[] {
  return git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter((b) => b !== "");
}

interface Worker {
  run(argv: string[], steps?: FakeStep[], overrides?: Partial<WorkerDeps>): Promise<{ code: number; out: string; err: string }>;
  calls: FakeCall[];
}

function worker(): Worker {
  const calls: FakeCall[] = [];
  return {
    calls,
    async run(argv, steps = [], overrides = {}) {
      let out = "";
      let err = "";
      const fake = createFakeRoleRunner(new LedgerRecorder(db.pool), steps);
      const deps: WorkerDeps = {
        db: db.pool,
        forge,
        runRole: fake.runRole,
        role,
        home,
        out: (text) => (out += text),
        err: (text) => (err += text),
        ...overrides,
      };
      const code = await runWorker(argv, deps);
      calls.push(...fake.calls);
      return { code, out, err };
    },
  };
}

const intake = (n = ISSUE.number) => ["intake", "--issue", String(n)];
const propose = (n = ISSUE.number) => ["proposal", "--issue", String(n)];

async function attemptCount(): Promise<number> {
  const workItem = await findWorkItemByIssue(db.pool, ISSUE.number);
  return workItem === undefined ? 0 : (await listAttempts(db.pool, workItem.id)).length;
}

async function workItemCount(): Promise<number> {
  const { rows: tables } = await db.pool.query<{ t: string | null }>("SELECT to_regclass('work_items')::text AS t");
  if (tables[0]?.t == null) return 0;
  const { rows } = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM work_items");
  return Number(rows[0]?.n);
}

beforeAll(async () => {
  // Never migrated here: the worker migrates at start-up.
  db = await createTestDatabase("worker");
  role = await loadRole("proposal-author");
  return () => db.close();
});

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  root = realpathSync(mkdtempSync(join(tmpdir(), "factory-worker-")));
  remote = join(root, "remote.git");
  // The task's temp home; the worker creates it.
  home = join(root, "home");

  git(root, "init", "--bare", "-b", "master", remote);
  const seed = join(root, "seed");
  git(root, "clone", remote, seed);
  write(seed, "README.md", "# vocab\n");
  write(seed, "openspec/config.yaml", "schema: spec-driven\n");
  write(seed, "openspec/specs/vocab-import/spec.md", "# vocab-import\n\n## Purpose\nImporting Kindle lookups.\n\n## Requirements\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "initial");
  git(seed, "push", "origin", "master");
  rmSync(seed, { recursive: true, force: true });

  const issues: FakeIssue[] = [ISSUE, EMPTY_ISSUE];
  forge = new FakeForge({ remote, issues });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  // An empty schema again, so every test also proves the worker migrates at start-up.
  await db.pool.query(`DROP SCHEMA "${db.schema}" CASCADE; CREATE SCHEMA "${db.schema}"`);
});

describe("factory-worker intake", () => {
  it("Scenario: Worker runs Intake for an issue", async () => {
    const w = worker();

    const { code } = await w.run(intake());

    expect(code).toBe(WORKER_EXIT.ok);
    const workItem = await findWorkItemByIssue(db.pool, ISSUE.number);
    expect(workItem?.state).toBe("proposal");
    expect(workItem?.changeId).toBe(CHANGE_ID);
    expect(remoteBranches()).toContain(CHANGE_ID);
    expect(w.calls).toHaveLength(0);
  });

  it("Scenario: Worker reports a rejected issue", async () => {
    const w = worker();

    const { code } = await w.run(intake(EMPTY_ISSUE.number));

    expect(code).toBe(WORKER_EXIT.ended);
    expect(await workItemCount()).toBe(0);
    expect(remoteBranches()).toEqual(["master"]);
    expect(forge.comments).toEqual([{ issueNumber: EMPTY_ISSUE.number, body: MISSING_REQUIREMENT_COMMENT }]);
  });

  it("re-running Intake for an issue past Intake changes nothing and exits 0", async () => {
    const w = worker();
    expect((await w.run(intake())).code).toBe(WORKER_EXIT.ok);

    const { code } = await w.run(intake());

    expect(code).toBe(WORKER_EXIT.ok);
    expect(await workItemCount()).toBe(1);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal");
  });
});

describe("factory-worker proposal", () => {
  it("Scenario: Worker advances a proposal", async () => {
    const w = worker();
    expect((await w.run(intake())).code).toBe(WORKER_EXIT.ok);
    const before = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);

    const { code } = await w.run(propose(), [VALID]);

    expect(code).toBe(WORKER_EXIT.ok);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("awaiting-proposal-approval");
    // The role worked in a worktree under the task's temp home, from a clone the worker made.
    expect(w.calls).toHaveLength(1);
    const worktree = w.calls[0]?.item.worktree ?? "";
    expect(worktree.startsWith(`${home}/`)).toBe(true);
    expect(git(worktree, "remote", "get-url", "origin")).toBe(remote);
    // The change is on the remote branch, one commit on top of where Intake left it.
    const head = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);
    expect(git(remote, "rev-parse", `${head}^`)).toBe(before);
    const files = git(remote, "ls-tree", "-r", "--name-only", head).split("\n");
    expect(files).toContain(`openspec/changes/${CHANGE_ID}/proposal.md`);
    expect(files).toContain(`openspec/changes/${CHANGE_ID}/specs/vocab-import/spec.md`);
  });

  it("Scenario: Repeated worker task does nothing", async () => {
    const w = worker();
    expect((await w.run(intake())).code).toBe(WORKER_EXIT.ok);
    expect((await w.run(propose(), [VALID])).code).toBe(WORKER_EXIT.ok);
    const head = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);
    const attempts = await attemptCount();
    const comments = forge.comments.length;

    // No scripted steps: any role run would fail the fake.
    const { code } = await w.run(propose());

    expect(code).toBe(WORKER_EXIT.ok);
    expect(w.calls).toHaveLength(1);
    expect(await attemptCount()).toBe(attempts);
    expect(forge.comments).toHaveLength(comments);
    expect(git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`)).toBe(head);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("awaiting-proposal-approval");
  });

  it("Scenario: Worker reports an escalation", async () => {
    const w = worker();
    expect((await w.run(intake())).code).toBe(WORKER_EXIT.ok);

    const { code } = await w.run(propose(), [INVALID, INVALID, INVALID]);

    expect(code).toBe(WORKER_EXIT.escalated);
    expect(w.calls).toHaveLength(3);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("escalated");
    expect(forge.comments).toHaveLength(1);
    expect(forge.comments[0]?.issueNumber).toBe(ISSUE.number);
    expect(forge.comments[0]?.body).toContain("escalated");
  });

  it("Scenario: Commits are authored by the factory's bot", async () => {
    const w = worker();
    expect((await w.run(intake())).code).toBe(WORKER_EXIT.ok);

    expect((await w.run(propose(), [VALID], { committer: BOT })).code).toBe(WORKER_EXIT.ok);

    const identity = git(remote, "log", "-1", "--format=%an|%ae|%cn|%ce", `refs/heads/${CHANGE_ID}`);
    expect(identity).toBe(`${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`);
  });
});

describe("factory-worker input", () => {
  it("Scenario: Unknown state is refused", async () => {
    const w = worker();
    expect((await w.run(intake())).code).toBe(WORKER_EXIT.ok);
    const attempts = await attemptCount();

    const design = await w.run(["design", "--issue", String(ISSUE.number)], [VALID]);

    expect(design.code).toBe(WORKER_EXIT.invalid);
    expect(design.err).toContain("design");

    const noWorkItem = await w.run(propose(EMPTY_ISSUE.number), [VALID]);

    expect(noWorkItem.code).toBe(WORKER_EXIT.invalid);
    expect(noWorkItem.err).toContain(`#${String(EMPTY_ISSUE.number)}`);
    expect(noWorkItem.err).toMatch(/no work item/i);

    expect(w.calls).toHaveLength(0);
    expect(await attemptCount()).toBe(attempts);
    expect(await workItemCount()).toBe(1);
    expect(forge.comments).toHaveLength(0);
    // Nothing was cloned into the task's home.
    expect(existsSync(home) ? readdirSync(home) : []).toEqual([]);
  });

  it.each([
    ["no arguments", []],
    ["no state", ["--issue", "12"]],
    ["no issue", ["intake"]],
    ["a non-numeric issue", ["intake", "--issue", "twelve"]],
    ["an unknown option", ["intake", "--issue", "12", "--until", "proposal"]],
    ["an extra argument", ["intake", "extra", "--issue", "12"]],
  ])("refuses %s with exit 2 and a usage message", async (_label, argv) => {
    const w = worker();

    const { code, err } = await w.run(argv);

    expect(code).toBe(WORKER_EXIT.invalid);
    expect(err).toMatch(/usage/i);
    expect(await workItemCount()).toBe(0);
  });

  it("refuses an issue the forge does not have with exit 2", async () => {
    const w = worker();

    const { code, err } = await w.run(intake(404));

    expect(code).toBe(WORKER_EXIT.invalid);
    expect(err).toContain("#404");
    expect(await workItemCount()).toBe(0);
  });

  it("exits 1 with the error's message on any other failure", async () => {
    const w = worker();
    const failing = new FakeForge({ remote, issues: [ISSUE] });
    vi.spyOn(failing, "getIssue").mockRejectedValue(new ForgeError("GitHub: reading issue #12 failed: 502 Bad Gateway", "failed", 502));

    const { code, err } = await w.run(intake(), [], { forge: failing });

    expect(code).toBe(WORKER_EXIT.error);
    expect(err).toContain("502 Bad Gateway");
  });
});
