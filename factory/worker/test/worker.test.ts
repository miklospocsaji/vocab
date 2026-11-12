/**
 * The worker (add-factory-worker task 1.12, add-cloud-proposal-run task 3.4): `runWorker`
 * with a FakeForge on a temp bare remote, the scripted fake role runner, a fake Step Functions
 * client and the real ledger.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "@vocab/factory-forge";
import { FakeForge, type FakeIssue } from "@vocab/factory-forge/testing";
import { createWorkItem, findOpenApproval, findWorkItemByIssue, LedgerRecorder, listAttempts, type ApprovalRow } from "@vocab/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@vocab/factory-ledger/testing";
import { MISSING_REQUIREMENT_COMMENT } from "@vocab/factory-orchestrator";
import { loadRole, type Role } from "@vocab/factory-roles";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGE_FILES, createFakeRoleRunner, type FakeCall, type FakeStep } from "../../orchestrator/test/fake-role-runner.ts";
import { runWorker, WORKER_EXIT, type WorkerDeps, type WorkerIdentity } from "../src/worker.ts";
import { FakeTaskTokens } from "./fake-task-tokens.ts";

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
let taskTokens: FakeTaskTokens;

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
        taskTokens,
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
  taskTokens = new FakeTaskTokens();
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

// add-cloud-proposal-run task 3.4: the cloud states.

const EXECUTION = "arn:aws:states:eu-central-1:123456789012:execution:factory-work-item:issue-12-5f0c";
const OTHER_EXECUTION = "arn:aws:states:eu-central-1:123456789012:execution:factory-work-item:issue-12-9d1e";
const TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAeTaskToken";
const OWNER = "miklospocsaji";

const cloudIntake = (arn = EXECUTION) => ["intake", "--issue", String(ISSUE.number), "--execution", arn];
const awaitApproval = (n = ISSUE.number) => ["await-approval", "--issue", String(n)];
const approve = (n = ISSUE.number, by = OWNER) => ["approve", "--issue", String(n), "--by", by];
const approved = (n = ISSUE.number) => ["approved", "--issue", String(n)];
const escalate = (reason: string, n = ISSUE.number) => ["escalate", "--issue", String(n), "--reason", reason];

/** The proposal author in api-key mode, as the worker runs it in the cloud. */
const apiKeyRole = (): Role => ({ ...role, authMode: "api-key" });

async function approvals(): Promise<ApprovalRow[]> {
  const workItem = await findWorkItemByIssue(db.pool, ISSUE.number);
  if (workItem === undefined) return [];
  const { rows } = await db.pool.query<{ id: string; state: string; task_token: string; resolved_by: string | null }>(
    "SELECT id, state, task_token, resolved_by FROM approvals WHERE work_item_id = $1 ORDER BY id",
    [workItem.id],
  );
  return rows.map((row) => ({
    id: row.id,
    workItemId: workItem.id,
    kind: "proposal",
    state: row.state as ApprovalRow["state"],
    taskToken: row.task_token,
    requestedAt: new Date(0),
    resolvedAt: null,
    resolvedBy: row.resolved_by,
  }));
}

/** Intake and a valid proposal in the cloud: the work item is awaiting-proposal-approval. */
async function proposed(w: Worker, steps: FakeStep[] = [VALID]): Promise<void> {
  expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);
  expect((await w.run(propose(), steps, { role: apiKeyRole() })).code).toBe(WORKER_EXIT.ok);
  expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("awaiting-proposal-approval");
}

/** Then AwaitApproval, which stores the approval and posts the summary. */
async function awaiting(w: Worker, steps: FakeStep[] = [VALID]): Promise<void> {
  await proposed(w, steps);
  expect((await w.run(awaitApproval(), [], { taskToken: TOKEN })).code).toBe(WORKER_EXIT.ok);
}

describe("factory-worker intake in the cloud", () => {
  it("records the execution's ARN on the work item, and a retry of the same execution goes on", async () => {
    const w = worker();

    expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);
    expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);

    const workItem = await findWorkItemByIssue(db.pool, ISSUE.number);
    expect(workItem?.executionArn).toBe(EXECUTION);
    expect(workItem?.state).toBe("proposal");
    expect(await workItemCount()).toBe(1);
  });

  it("Scenario: Relabelling does not create a second work item", async () => {
    const w = worker();
    await proposed(w);
    const before = await findWorkItemByIssue(db.pool, ISSUE.number);
    const branches = remoteBranches();
    const comments = forge.comments.length;

    const { code } = await w.run(cloudIntake(OTHER_EXECUTION));

    expect(code).toBe(WORKER_EXIT.ended);
    expect(await workItemCount()).toBe(1);
    const after = await findWorkItemByIssue(db.pool, ISSUE.number);
    expect(after?.executionArn).toBe(EXECUTION);
    expect(after?.state).toBe("awaiting-proposal-approval");
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(remoteBranches()).toEqual(branches);
    expect(forge.comments).toHaveLength(comments);
    expect(w.calls).toHaveLength(1);
  });

  it("ends an Intake that loses the insert to a concurrent one with exit 4, creating nothing", async () => {
    const w = worker();
    const getIssue = forge.getIssue.bind(forge);
    // The other execution's Intake inserts its work item while this one reads the issue.
    vi.spyOn(forge, "getIssue").mockImplementation(async (n) => {
      await createWorkItem(db.pool, { issueNumber: n, changeId: "add-kindle-import", branch: "add-kindle-import", state: "intake", executionArn: OTHER_EXECUTION });
      return getIssue(n);
    });

    const { code } = await w.run(cloudIntake());

    expect(code).toBe(WORKER_EXIT.ended);
    expect(await workItemCount()).toBe(1);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.executionArn).toBe(OTHER_EXECUTION);
    expect(remoteBranches()).toEqual(["master"]);
  });
});

describe("factory-worker await-approval", () => {
  it("Scenario: Execution waits for approval", async () => {
    const w = worker();
    await proposed(w);
    const comment = forge.comment.bind(forge);
    const openWhenCommented: (ApprovalRow | undefined)[] = [];
    vi.spyOn(forge, "comment").mockImplementation(async (n, body) => {
      const workItem = await findWorkItemByIssue(db.pool, n);
      openWhenCommented.push(workItem === undefined ? undefined : await findOpenApproval(db.pool, workItem.id));
      return comment(n, body);
    });

    const { code } = await w.run(awaitApproval(), [], { taskToken: TOKEN });

    expect(code).toBe(WORKER_EXIT.ok);
    // The approval with its token was in the ledger before the summary was posted.
    expect(openWhenCommented).toHaveLength(1);
    expect(openWhenCommented[0]).toMatchObject({ state: "open", taskToken: TOKEN });
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("awaiting-proposal-approval");
    // The execution stays paused: nothing resumed or failed the task.
    expect(taskTokens.successes).toEqual([]);
    expect(taskTokens.failures).toEqual([]);

    // The summary lists what M1's does, with Why and What Changes from the pushed proposal.md.
    expect(forge.comments).toHaveLength(1);
    const body = forge.comments[0]?.body ?? "";
    expect(forge.comments[0]?.issueNumber).toBe(ISSUE.number);
    expect(body).toContain(CHANGE_ID);
    expect(body).toContain("vocab-import");
    expect(body).toMatch(/complexity\W+small/i);
    expect(body).toContain("Owners want their Kindle lookups in the app.");
    expect(body).toContain("Import the lookups from a Kindle vocab.db.");
    expect(body).not.toContain(TOKEN);
  });

  it("Scenario: Summary shows the cost", async () => {
    const w = worker();
    // Two attempts: the summary counts both.
    await awaiting(w, [{ ...INVALID, costUsd: 0.25 }, { ...VALID, costUsd: 0.5 }]);

    const body = forge.comments.at(-1)?.body ?? "";
    // Each fake attempt reports 1,000 input and 500 output tokens.
    expect(body).toContain("3,000 tokens");
    expect(body).toContain("$0.75");
    expect(body).toContain("`api-key`");
    const last = body.trim().split("\n\n").at(-1) ?? "";
    expect(last).toMatch(/reply `\/approve`/i);
  });

  it("sends SendTaskFailure with a fixed cause when it fails, and exits 1", async () => {
    const w = worker();
    await proposed(w);
    vi.spyOn(forge, "comment").mockRejectedValue(new ForgeError("GitHub: commenting on #12 failed: 502 Bad Gateway, token ghs_secret", "failed", 502));

    const { code } = await w.run(awaitApproval(), [], { taskToken: TOKEN });

    expect(code).toBe(WORKER_EXIT.error);
    expect(taskTokens.failures).toHaveLength(1);
    const [failure] = taskTokens.failures;
    expect(failure?.taskToken).toBe(TOKEN);
    // Execution history shows the error and cause: nothing from the failure itself.
    expect(`${failure?.error ?? ""} ${failure?.cause ?? ""}`).not.toMatch(/502|ghs_|GitHub/);
    expect(taskTokens.successes).toEqual([]);
  });

  it("fails the task, storing nothing, when the work item is not awaiting approval", async () => {
    const w = worker();
    expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);

    const { code } = await w.run(awaitApproval(), [], { taskToken: TOKEN });

    expect(code).toBe(WORKER_EXIT.invalid);
    expect(taskTokens.failures.map((failure) => failure.taskToken)).toEqual([TOKEN]);
    expect(await approvals()).toEqual([]);
    expect(forge.comments).toEqual([]);
  });

  it("refuses to run without a task token", async () => {
    const w = worker();
    await proposed(w);

    const { code, err } = await w.run(awaitApproval());

    expect(code).toBe(WORKER_EXIT.invalid);
    expect(err).toContain("FACTORY_TASK_TOKEN");
    expect(await approvals()).toEqual([]);
    expect(forge.comments).toEqual([]);
  });
});

describe("factory-worker approve and approved", () => {
  it("Scenario: Owner's approval resumes the execution", async () => {
    const w = worker();
    await awaiting(w);

    expect((await w.run(approve())).code).toBe(WORKER_EXIT.ok);

    // approve closes the approval with the owner's login and resumes the execution with its token.
    expect(taskTokens.successes.map((success) => success.taskToken)).toEqual([TOKEN]);
    expect(await approvals()).toEqual([expect.objectContaining({ state: "closed", taskToken: TOKEN, resolvedBy: OWNER })]);

    // The execution goes on to Approved.
    const comments = forge.comments.length;
    expect((await w.run(approved())).code).toBe(WORKER_EXIT.ok);

    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal-approved");
    expect(forge.comments).toHaveLength(comments + 1);
    expect(forge.comments.at(-1)?.body).toMatch(/approved/i);
    expect(forge.comments.at(-1)?.body).toContain("proposal-approved");

    // A retry of Approved changes nothing and posts nothing.
    expect((await w.run(approved())).code).toBe(WORKER_EXIT.ok);
    expect(forge.comments).toHaveLength(comments + 1);
  });

  it("Scenario: Approval with nothing awaiting is answered", async () => {
    const w = worker();
    expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);

    expect((await w.run(approve())).code).toBe(WORKER_EXIT.ok);

    expect(taskTokens.successes).toEqual([]);
    expect(forge.comments).toHaveLength(1);
    expect(forge.comments[0]?.body).toMatch(/nothing awaits approval/i);
    expect(forge.comments[0]?.body).toContain("`proposal`");
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal");

    // An issue without a work item gets an answer too.
    expect((await w.run(approve(EMPTY_ISSUE.number))).code).toBe(WORKER_EXIT.ok);
    expect(forge.comments.at(-1)).toMatchObject({ issueNumber: EMPTY_ISSUE.number, body: expect.stringMatching(/nothing awaits approval/i) as unknown });
    expect(taskTokens.successes).toEqual([]);
  });

  it("answers a second /approve after the first resumed the execution, without resuming it again", async () => {
    const w = worker();
    await awaiting(w);
    expect((await w.run(approve())).code).toBe(WORKER_EXIT.ok);

    expect((await w.run(approve())).code).toBe(WORKER_EXIT.ok);

    expect(taskTokens.successes).toHaveLength(1);
    expect(forge.comments.at(-1)?.body).toMatch(/nothing awaits approval/i);
  });

  it("reopens the approval and says so when SendTaskSuccess fails", async () => {
    const w = worker();
    await awaiting(w);
    taskTokens.failNextSuccess = new Error("ThrottlingException: Rate exceeded");

    const { code } = await w.run(approve());

    expect(code).toBe(WORKER_EXIT.error);
    expect(await approvals()).toEqual([expect.objectContaining({ state: "open", taskToken: TOKEN, resolvedBy: null })]);
    expect(forge.comments.at(-1)?.body).toMatch(/`\/approve`/);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("awaiting-proposal-approval");

    // The owner tries again, and it goes through.
    expect((await w.run(approve())).code).toBe(WORKER_EXIT.ok);
    expect(taskTokens.successes.map((success) => success.taskToken)).toEqual([TOKEN]);
  });

  it("refuses approve without the approver's login, and approved for a work item not awaiting approval", async () => {
    const w = worker();
    expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);

    expect((await w.run(["approve", "--issue", String(ISSUE.number)])).code).toBe(WORKER_EXIT.invalid);
    expect((await w.run(approve(ISSUE.number, "not a login"))).code).toBe(WORKER_EXIT.invalid);
    expect((await w.run(approved())).code).toBe(WORKER_EXIT.invalid);

    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal");
    expect(forge.comments).toEqual([]);
  });
});

describe("factory-worker escalate", () => {
  it("Scenario: Worker crash escalates the work item", async () => {
    const w = worker();
    expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);

    const { code } = await w.run(escalate("worker-failed"));

    expect(code).toBe(WORKER_EXIT.ok);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("escalated");
    expect(forge.comments).toHaveLength(1);
    const body = forge.comments[0]?.body ?? "";
    expect(body).toContain(CHANGE_ID);
    expect(body).toContain("`worker-failed`");
    expect(body).toMatch(/infrastructure/i);

    // Repeated: nothing more.
    expect((await w.run(escalate("worker-failed"))).code).toBe(WORKER_EXIT.ok);
    expect(forge.comments).toHaveLength(1);
  });

  it("comments with the fixed reason worker-refused, and on an issue with no work item", async () => {
    const w = worker();

    expect((await w.run(escalate("worker-refused"))).code).toBe(WORKER_EXIT.ok);

    expect(await workItemCount()).toBe(0);
    expect(forge.comments).toHaveLength(1);
    expect(forge.comments[0]?.issueNumber).toBe(ISSUE.number);
    expect(forge.comments[0]?.body).toContain("`worker-refused`");
  });

  it("refuses any other reason", async () => {
    const w = worker();
    expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);

    const { code } = await w.run(escalate("CannotPullContainerError: secret=abc"));

    expect(code).toBe(WORKER_EXIT.invalid);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal");
    expect(forge.comments).toEqual([]);
  });
});
