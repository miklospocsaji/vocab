/**
 * The worker (add-factory-worker task 1.12, add-cloud-proposal-run task 3.4, add-build-loop
 * task 4.1): `runWorker` with a FakeForge on a temp bare remote, the scripted fake role runner,
 * a fake Step Functions client, an FsStore with the fake build runner, and the real ledger.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "@vocab/factory-forge";
import { FakeForge, type FakeIssue } from "@vocab/factory-forge/testing";
import { createWorkItem, findOpenApproval, findWorkItemByIssue, LedgerRecorder, listAttempts, type ApprovalRow } from "@vocab/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@vocab/factory-ledger/testing";
import { DESIGN_APPROVAL_INSTRUCTION, MISSING_REQUIREMENT_COMMENT } from "@vocab/factory-orchestrator";
import { loadRole, type Role } from "@vocab/factory-roles";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { classified, CODE, codeFor, TESTS, testsFor } from "../../orchestrator/test/build-harness.ts";
import { createFakeBuildRunner, type FakeBuildRunner, type FakeBuildStep } from "../../orchestrator/test/fake-build-runner.ts";
import { CHANGE_FILES, createFakeRoleRunner, type FakeCall, type FakeStep } from "../../orchestrator/test/fake-role-runner.ts";
import { PLAN, planStep, proposalStep, TASKS_MD } from "../../orchestrator/test/work-item-fixture.ts";
import { FsStore } from "../src/store.ts";
import { runWorker, WORKER_EXIT, type WorkerDeps, type WorkerIdentity, type WorkerRoles } from "../src/worker.ts";
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
let roles: WorkerRoles;
let store: FsStore;
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
        roles,
        store,
        cloneUrl: remote,
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
  const [architect, designReviewer, planner, testAuthor, implementer, classifier] = await Promise.all(
    ["architect", "design-reviewer", "planner", "test-author", "implementer", "failure-classifier"].map((name) => loadRole(name)),
  );
  if (architect === undefined || designReviewer === undefined || planner === undefined || testAuthor === undefined || implementer === undefined || classifier === undefined) {
    throw new Error("a role config is missing");
  }
  roles = { architect, designReviewer, planner, testAuthor, implementer, classifier };
  return () => db.close();
});

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  root = realpathSync(mkdtempSync(join(tmpdir(), "factory-worker-")));
  remote = join(root, "remote.git");
  // The task's temp home; the worker creates it.
  home = join(root, "home");
  store = new FsStore(join(root, "store"));

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

    const deploy = await w.run(["deploy", "--issue", String(ISSUE.number)], [VALID]);

    expect(deploy.code).toBe(WORKER_EXIT.invalid);
    expect(deploy.err).toContain("deploy");

    const noTask = await w.run(["step", "--issue", String(ISSUE.number)], [VALID]);

    expect(noTask.code).toBe(WORKER_EXIT.invalid);
    expect(noTask.err).toContain("--task");

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
    ["--task for a state other than step", ["plan", "--issue", "12", "--task", "1.1"]],
    ["an invalid task id", ["step", "--issue", "12", "--task", "1.1; rm -rf /"]],
    ["an unknown approval kind", ["await-approval", "--issue", "12", "--kind", "release"]],
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
  const { rows } = await db.pool.query<{ id: string; kind: string; state: string; task_token: string; resolved_by: string | null }>(
    "SELECT id, kind, state, task_token, resolved_by FROM approvals WHERE work_item_id = $1 ORDER BY id",
    [workItem.id],
  );
  return rows.map((row) => ({
    id: row.id,
    workItemId: workItem.id,
    kind: row.kind as ApprovalRow["kind"],
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
    expect(await approvals()).toEqual([expect.objectContaining({ kind: "proposal", state: "closed", taskToken: TOKEN, resolvedBy: OWNER })]);

    // The execution goes on to Approved.
    const comments = forge.comments.length;
    expect((await w.run(approved())).code).toBe(WORKER_EXIT.skipDesign);

    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal-approved");
    expect(forge.comments).toHaveLength(comments + 1);
    expect(forge.comments.at(-1)?.body).toMatch(/approved/i);
    expect(forge.comments.at(-1)?.body).toContain("proposal-approved");
    // The confirmation names the approval it closed.
    expect(forge.comments.at(-1)?.body).toMatch(/\bproposal\b.*\bapproved\b/i);
    expect(forge.comments.at(-1)?.body).not.toMatch(/\bdesign\b.*\bapproved\b/i);

    // A retry of Approved changes nothing and posts nothing.
    expect((await w.run(approved())).code).toBe(WORKER_EXIT.skipDesign);
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

  it("Scenario: Failed resume is reported on the issue", async () => {
    const w = worker();
    await awaiting(w);
    const comments = forge.comments.length;
    taskTokens.failNextSuccess = new Error("ThrottlingException: Rate exceeded");

    const { code } = await w.run(approve());

    expect(code).toBe(WORKER_EXIT.error);
    expect(await approvals()).toEqual([expect.objectContaining({ state: "open", taskToken: TOKEN, resolvedBy: null })]);
    // One comment: the approval of the proposal did not go through, and can be repeated.
    expect(forge.comments).toHaveLength(comments + 1);
    const body = forge.comments.at(-1)?.body ?? "";
    expect(body).toMatch(/did not go through/i);
    expect(body).toMatch(/\bproposal\b/);
    expect(body).toMatch(/`\/approve`/);
    expect(body).not.toContain("Throttling");
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("awaiting-proposal-approval");

    // The owner tries again, and it goes through.
    expect((await w.run(approve())).code).toBe(WORKER_EXIT.ok);
    expect(taskTokens.successes.map((success) => success.taskToken)).toEqual([TOKEN]);
  });

  it("comments on the issue when the approve task fails before it can resume, leaving the approval open", async () => {
    const w = worker();
    await awaiting(w);
    const comments = forge.comments.length;
    // The ledger fails while closing the approval (M2's exit run: a ledger that did not answer).
    const pool = db.pool as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const query = pool.query.bind(pool);
    vi.spyOn(pool, "query").mockImplementation(async (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      if (/UPDATE approvals SET state = 'closed'/.test(text)) throw new Error("Connection terminated unexpectedly, password=hunter2");
      return query(...args);
    });

    const { code } = await w.run(approve());
    vi.restoreAllMocks();

    expect(code).toBe(WORKER_EXIT.error);
    expect(taskTokens.successes).toEqual([]);
    expect(await approvals()).toEqual([expect.objectContaining({ state: "open", taskToken: TOKEN })]);
    expect(forge.comments).toHaveLength(comments + 1);
    const body = forge.comments.at(-1)?.body ?? "";
    expect(forge.comments.at(-1)?.issueNumber).toBe(ISSUE.number);
    expect(body).toMatch(/did not go through/i);
    expect(body).toMatch(/`\/approve`/);
    expect(body).not.toMatch(/hunter2|Connection terminated/);
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

// add-build-loop task 4.1: the states after Proposal.

const DESIGN_TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAeDesignToken";
const PLAN_TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAePlanToken";

const DESIGN_MD = ["# Design", "", "## Overview", "", "Read vocab.db with node:sqlite and map each lookup to a word.", ""].join("\n");
const DESIGN_RESULT = {
  summary: "Read vocab.db with node:sqlite and map each lookup to a word.",
  contracts: ["app/contracts/src/lookup.ts"],
  adrNeeded: [],
  openQuestions: [],
};
const ARCHITECT: FakeStep = { files: { "design.md": DESIGN_MD }, result: DESIGN_RESULT };
const REVIEW_APPROVE: FakeStep = { result: { verdict: "approve", findings: [] } };
const REVIEW_CHANGES: FakeStep = {
  result: { verdict: "changes-requested", findings: [{ severity: "blocker", location: "design.md#Overview", summary: "Duplicate lookups are not merged." }] },
};
const BAD_PLAN = planStep(TASKS_MD, { tasks: [{ ...PLAN.tasks[0], scenarios: ["No such scenario"] }, PLAN.tasks[1]] });

const design = (n = ISSUE.number) => ["design", "--issue", String(n)];
const plan = (n = ISSUE.number) => ["plan", "--issue", String(n)];
const stepTask = (taskId: string, n = ISSUE.number) => ["step", "--issue", String(n), "--task", taskId];
const openPr = (n = ISSUE.number) => ["open-pr", "--issue", String(n)];
const awaitDesignApproval = (n = ISSUE.number) => ["await-approval", "--issue", String(n), "--kind", "design"];

async function stateOf(): Promise<string | undefined> {
  return (await findWorkItemByIssue(db.pool, ISSUE.number))?.state;
}

/** Intake, a proposal of the given complexity, the owner's approval and Approved. */
async function approvedItem(w: Worker, complexity: string): Promise<number> {
  expect((await w.run(cloudIntake())).code).toBe(WORKER_EXIT.ok);
  expect((await w.run(propose(), [proposalStep(complexity)])).code).toBe(WORKER_EXIT.ok);
  expect((await w.run(awaitApproval(), [], { taskToken: TOKEN })).code).toBe(WORKER_EXIT.ok);
  expect((await w.run(approve())).code).toBe(WORKER_EXIT.ok);
  const { code } = await w.run(approved());
  expect(await stateOf()).toBe("proposal-approved");
  return code;
}

/** The output Plan resumed the execution with, parsed. */
function planOutputs(): unknown[] {
  return taskTokens.successes.filter((success) => success.taskToken === PLAN_TOKEN).map((success) => JSON.parse(success.output) as unknown);
}

/** A small change through Plan: the work item is in `build` with PLAN's tasks. */
async function plannedItem(w: Worker): Promise<void> {
  await approvedItem(w, "small");
  expect((await w.run(plan(), [planStep()], { taskToken: PLAN_TOKEN })).code).toBe(WORKER_EXIT.ok);
  expect(await stateOf()).toBe("build");
}

/** Steps a task, running the build each exit 20 or 21 asks for, until a step exits otherwise; the exit codes in order. */
async function buildTask(w: Worker, builds: FakeBuildRunner, taskId: string, classifications: FakeStep[] = []): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const { code, err } = await w.run(stepTask(taskId), classifications);
    codes.push(code);
    if (code !== WORKER_EXIT.build && code !== WORKER_EXIT.buildAfterWait) {
      if (code === WORKER_EXIT.error || code === WORKER_EXIT.invalid) throw new Error(`step exited ${String(code)}: ${err}`);
      return codes;
    }
    await builds.runBuild({ changeId: CHANGE_ID, taskId });
  }
  throw new Error(`task ${taskId} took more than 12 steps`);
}

const fakeBuilds = (steps: FakeBuildStep[]): FakeBuildRunner => createFakeBuildRunner(store, steps);
const BOOKS_TEST = "app/domain/test/books.test.ts";
const BOOKS_SOURCE = "app/domain/src/books.ts";

describe("factory-worker approved routes on complexity", { timeout: 60_000 }, () => {
  it("exits 10 for a small change, which skips Design", async () => {
    expect(await approvedItem(worker(), "small")).toBe(WORKER_EXIT.skipDesign);
  });

  it("exits 0 for a medium change, which goes to Design", async () => {
    expect(await approvedItem(worker(), "medium")).toBe(WORKER_EXIT.ok);
  });
});

describe("factory-worker design", { timeout: 60_000 }, () => {
  it("runs the architect and the design reviewer for a medium change, then exits 0 for Plan", async () => {
    const w = worker();
    await approvedItem(w, "medium");
    const before = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);

    const { code } = await w.run(design(), [ARCHITECT, REVIEW_APPROVE]);

    expect(code).toBe(WORKER_EXIT.ok);
    expect(w.calls.map((call) => call.role).slice(-2)).toEqual(["architect", "design-reviewer"]);
    expect(await stateOf()).toBe("plan");
    // The accepted design is pushed, from the task's own clone.
    const head = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);
    expect(head).not.toBe(before);
    expect(git(remote, "ls-tree", "-r", "--name-only", head)).toContain(`openspec/changes/${CHANGE_ID}/design.md`);
    expect(w.calls.at(-1)?.item.worktree.startsWith(`${home}/`)).toBe(true);
  });

  it("exits 3 when three designs are answered with changes-requested", async () => {
    const w = worker();
    await approvedItem(w, "medium");

    const { code } = await w.run(design(), [ARCHITECT, REVIEW_CHANGES, ARCHITECT, REVIEW_CHANGES, ARCHITECT, REVIEW_CHANGES]);

    expect(code).toBe(WORKER_EXIT.escalated);
    expect(await stateOf()).toBe("escalated");
  });

  it("exits 11 for a large change, whose design then waits for the owner's approval", async () => {
    const w = worker();
    await approvedItem(w, "large");

    const { code } = await w.run(design(), [ARCHITECT]);

    expect(code).toBe(WORKER_EXIT.ownerDesignReview);
    expect(w.calls.map((call) => call.role)).not.toContain("design-reviewer");
    expect(await stateOf()).toBe("awaiting-design-approval");

    // AwaitDesignApproval stores a design approval with its token, then posts the design summary.
    const comments = forge.comments.length;
    expect((await w.run(awaitDesignApproval(), [], { taskToken: DESIGN_TOKEN })).code).toBe(WORKER_EXIT.ok);
    expect((await approvals()).at(-1)).toMatchObject({ kind: "design", state: "open", taskToken: DESIGN_TOKEN });
    expect(forge.comments).toHaveLength(comments + 1);
    const summary = forge.comments.at(-1)?.body ?? "";
    expect(summary).toContain(DESIGN_RESULT.summary);
    expect(summary).toContain(DESIGN_APPROVAL_INSTRUCTION);
    expect(summary).not.toContain(DESIGN_TOKEN);
    expect(taskTokens.successes.map((success) => success.taskToken)).not.toContain(DESIGN_TOKEN);
  });

  it("resumes a design approval on the owner's /approve, and the confirmation names the design", async () => {
    const w = worker();
    await approvedItem(w, "large");
    expect((await w.run(design(), [ARCHITECT])).code).toBe(WORKER_EXIT.ownerDesignReview);
    expect((await w.run(awaitDesignApproval(), [], { taskToken: DESIGN_TOKEN })).code).toBe(WORKER_EXIT.ok);
    const comments = forge.comments.length;

    expect((await w.run(approve())).code).toBe(WORKER_EXIT.ok);

    expect(taskTokens.successes.map((success) => success.taskToken)).toEqual([TOKEN, DESIGN_TOKEN]);
    expect((await approvals()).at(-1)).toMatchObject({ kind: "design", state: "closed", resolvedBy: OWNER });
    expect(forge.comments).toHaveLength(comments + 1);
    const body = forge.comments.at(-1)?.body ?? "";
    expect(body).toContain(CHANGE_ID);
    expect(body).toMatch(/\bdesign\b.*\bapproved\b/i);

    // The execution goes on to Plan, which accepts the closed design approval.
    expect((await w.run(plan(), [planStep()], { taskToken: PLAN_TOKEN })).code).toBe(WORKER_EXIT.ok);
    expect(await stateOf()).toBe("build");
  });

  it("refuses await-approval --kind design for a work item not awaiting design approval", async () => {
    const w = worker();
    await approvedItem(w, "medium");

    const { code } = await w.run(awaitDesignApproval(), [], { taskToken: DESIGN_TOKEN });

    expect(code).toBe(WORKER_EXIT.invalid);
    expect(taskTokens.failures.map((failure) => failure.taskToken)).toEqual([DESIGN_TOKEN]);
  });
});

describe("factory-worker plan", { timeout: 60_000 }, () => {
  it("stores the plan and resumes the execution with the change id and the unfinished task ids", async () => {
    const w = worker();
    await approvedItem(w, "small");

    const { code } = await w.run(plan(), [planStep()], { taskToken: PLAN_TOKEN });

    expect(code).toBe(WORKER_EXIT.ok);
    expect(await stateOf()).toBe("build");
    expect(planOutputs()).toEqual([{ exitCode: 0, changeId: CHANGE_ID, tasks: ["1.1", "1.2"] }]);
    expect(taskTokens.failures).toEqual([]);
    const head = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);
    expect(git(remote, "ls-tree", "-r", "--name-only", head)).toContain(`openspec/changes/${CHANGE_ID}/tasks.md`);
  });

  it("resumes the execution with exit code 3 and no tasks when the plan escalates", async () => {
    const w = worker();
    await approvedItem(w, "small");

    const { code } = await w.run(plan(), [BAD_PLAN, BAD_PLAN, BAD_PLAN], { taskToken: PLAN_TOKEN });

    expect(code).toBe(WORKER_EXIT.escalated);
    expect(await stateOf()).toBe("escalated");
    expect(planOutputs()).toEqual([{ exitCode: 3, changeId: CHANGE_ID, tasks: [] }]);
    expect(taskTokens.failures).toEqual([]);
  });

  it("sends SendTaskFailure with a fixed cause on any other error, and exits 1", async () => {
    const w = worker();
    await approvedItem(w, "small");
    vi.spyOn(forge, "pushBranch").mockRejectedValue(new ForgeError("GitHub: pushing failed: 502 Bad Gateway, token ghs_secret", "failed", 502));

    const { code } = await w.run(plan(), [planStep()], { taskToken: PLAN_TOKEN });

    expect(code).toBe(WORKER_EXIT.error);
    expect(planOutputs()).toEqual([]);
    expect(taskTokens.failures).toHaveLength(1);
    const [failure] = taskTokens.failures;
    expect(failure?.taskToken).toBe(PLAN_TOKEN);
    expect(`${failure?.error ?? ""} ${failure?.cause ?? ""}`).not.toMatch(/502|ghs_|GitHub/);
  });

  it("answers a repeated Plan with the same task ids, running no role", async () => {
    const w = worker();
    await plannedItem(w);
    const calls = w.calls.length;

    expect((await w.run(plan(), [], { taskToken: PLAN_TOKEN })).code).toBe(WORKER_EXIT.ok);

    expect(w.calls).toHaveLength(calls);
    expect(planOutputs()).toEqual([
      { exitCode: 0, changeId: CHANGE_ID, tasks: ["1.1", "1.2"] },
      { exitCode: 0, changeId: CHANGE_ID, tasks: ["1.1", "1.2"] },
    ]);
  });

  it("refuses to run without a task token", async () => {
    const w = worker();
    await approvedItem(w, "small");

    const { code, err } = await w.run(plan());

    expect(code).toBe(WORKER_EXIT.invalid);
    expect(err).toContain("FACTORY_TASK_TOKEN");
    expect(await stateOf()).toBe("proposal-approved");
  });
});

describe("factory-worker step and open-pr", { timeout: 120_000 }, () => {
  it("builds every task through step and the build task, then opens the pull request once", async () => {
    const w = worker();
    await plannedItem(w);
    const builds = fakeBuilds([TESTS, CODE, testsFor(BOOKS_TEST, BOOKS_SOURCE, "Books are imported"), codeFor(BOOKS_SOURCE)]);

    // Each task: step writes the test author's input (20), records it and writes the implementer's (20), then ticks it (0).
    expect(await buildTask(w, builds, "1.1")).toEqual([WORKER_EXIT.build, WORKER_EXIT.build, WORKER_EXIT.ok]);
    expect(await buildTask(w, builds, "1.2")).toEqual([WORKER_EXIT.build, WORKER_EXIT.build, WORKER_EXIT.ok]);

    // The builds read their inputs from the worker's store, and cloned the remote with no token.
    expect(builds.calls.map((call) => [call.taskId, call.next.role])).toEqual([
      ["1.1", "test-author"],
      ["1.1", "implementer"],
      ["1.2", "test-author"],
      ["1.2", "implementer"],
    ]);
    for (const call of builds.calls) expect(call.input.cloneUrl).toBe(remote);
    const head = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);
    expect(git(remote, "show", `${head}:openspec/changes/${CHANGE_ID}/tasks.md`)).toContain("- [x] 1.2");

    // A repeated step of a ticked task does nothing.
    expect((await w.run(stepTask("1.1"))).code).toBe(WORKER_EXIT.ok);
    expect(builds.calls).toHaveLength(4);

    const comments = forge.comments.length;
    expect((await w.run(openPr())).code).toBe(WORKER_EXIT.ok);
    expect((await w.run(openPr())).code).toBe(WORKER_EXIT.ok);

    expect(await stateOf()).toBe("pr-open");
    expect(forge.pullRequests).toHaveLength(1);
    expect(forge.pullRequests[0]).toMatchObject({ head: CHANGE_ID, base: "master" });
    expect(forge.comments).toHaveLength(comments + 1);
    expect(forge.comments.at(-1)?.body).toContain(forge.pullRequests[0]?.url ?? "no url");
  });

  it("exits 21 after a build that left no outcome, so the build runs again after a wait", async () => {
    const w = worker();
    await plannedItem(w);
    const builds = fakeBuilds([{ noOutcome: true }]);

    expect((await w.run(stepTask("1.1"))).code).toBe(WORKER_EXIT.build);
    await builds.runBuild({ changeId: CHANGE_ID, taskId: "1.1" });

    expect((await w.run(stepTask("1.1"))).code).toBe(WORKER_EXIT.buildAfterWait);
    expect(await store.exists(`work-items/${CHANGE_ID}/tasks/1.1/next.json`)).toBe(true);
  });

  it("exits 13 on a design flaw, with the work item back in Design", async () => {
    const w = worker();
    await plannedItem(w);
    const builds = fakeBuilds([TESTS, { ...CODE, outcome: "failed", reason: "green", output: "TypeError: lookups.book is undefined" }]);

    const codes = await buildTask(w, builds, "1.1", [classified("design-flaw", "The design has no book on a lookup.")]);

    expect(codes).toEqual([WORKER_EXIT.build, WORKER_EXIT.build, WORKER_EXIT.designFlaw]);
    expect(await stateOf()).toBe("design");
  });

  it("exits 3 when the task escalates", async () => {
    const w = worker();
    await plannedItem(w);
    const builds = fakeBuilds([TESTS, { ...CODE, outcome: "failed", reason: "green", output: "AssertionError: expected 2 to be 1" }]);

    const codes = await buildTask(w, builds, "1.1", [classified("spec-ambiguity", "Should a lookup without a book be imported?")]);

    expect(codes).toEqual([WORKER_EXIT.build, WORKER_EXIT.build, WORKER_EXIT.escalated]);
    expect(await stateOf()).toBe("escalated");
  });

  it("refuses a task the plan does not have, and open-pr with unfinished tasks, with exit 2", async () => {
    const w = worker();
    await plannedItem(w);

    expect((await w.run(stepTask("9.9"))).code).toBe(WORKER_EXIT.invalid);
    expect((await w.run(openPr())).code).toBe(WORKER_EXIT.invalid);
    expect(forge.pullRequests).toEqual([]);
    expect(await stateOf()).toBe("build");
  });
});
