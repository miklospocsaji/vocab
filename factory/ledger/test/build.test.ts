// Migration 0003 and its queries (add-build-loop task 3.1): tasks, approval kinds, build attempts, design flaws.
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import {
  ApprovalAlreadyOpen,
  closeApproval,
  closeAttempt,
  createWorkItem,
  findOpenApproval,
  findWorkItemByIssue,
  incrementDesignFlaws,
  listAttempts,
  listTasks,
  markTaskDone,
  openApproval,
  openAttempt,
  setAttemptClassification,
  storePlan,
  type PlanTaskInput,
} from "../src/queries.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let db: TestDatabase;
let nextIssue = 1;

beforeAll(async () => {
  db = await createTestDatabase("build");
  await migrate(db.pool);
  return () => db.close();
});

async function newWorkItem(state = "plan"): Promise<string> {
  const issueNumber = nextIssue++;
  const item = await createWorkItem(db.pool, { issueNumber, changeId: `add-build-${String(issueNumber)}`, branch: `add-build-${String(issueNumber)}`, state });
  return item.id;
}

async function planAttempt(workItemId: string): Promise<string> {
  const attempt = await openAttempt(db.pool, { workItemId, state: "plan", role: "planner" });
  await closeAttempt(db.pool, attempt.id, { outcome: "succeeded" });
  return attempt.id;
}

const task = (id: string, title: string, overrides: Partial<PlanTaskInput> = {}): PlanTaskInput => ({
  id,
  title,
  dependsOn: [],
  files: [`app/domain/src/task-${id}.ts`],
  scenarios: [`Scenario of ${id}`],
  tests: [`app/domain/test/task-${id}.test.ts`],
  ...overrides,
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("tasks", () => {
  it("stores a plan's tasks in order, with their scenarios, files and tests", async () => {
    const workItemId = await newWorkItem();
    const planAttemptId = await planAttempt(workItemId);
    const tasks = [task("1.1", "Parse the words"), task("1.2", "Parse the lookups", { dependsOn: ["1.1"], scenarios: ["Lookups are imported", "Lookups keep their book"] })];

    const stored = await storePlan(db.pool, { workItemId, planAttemptId, tasks });

    expect(stored).toEqual([
      {
        id: expect.any(String) as unknown,
        workItemId,
        taskId: "1.1",
        position: 1,
        title: "Parse the words",
        dependsOn: [],
        files: ["app/domain/src/task-1.1.ts"],
        scenarios: ["Scenario of 1.1"],
        tests: ["app/domain/test/task-1.1.test.ts"],
        status: "pending",
        doneCommit: null,
        planAttemptId,
      },
      expect.objectContaining({
        taskId: "1.2",
        position: 2,
        dependsOn: ["1.1"],
        scenarios: ["Lookups are imported", "Lookups keep their book"],
        status: "pending",
        planAttemptId,
      }),
    ]);
    expect(await listTasks(db.pool, workItemId)).toEqual(stored);
  });

  it("marks a task done with its commit, once", async () => {
    const workItemId = await newWorkItem();
    await storePlan(db.pool, { workItemId, planAttemptId: await planAttempt(workItemId), tasks: [task("1.1", "Parse the words")] });

    const done = await markTaskDone(db.pool, workItemId, "1.1", SHA);

    expect(done).toMatchObject({ taskId: "1.1", status: "done", doneCommit: SHA });
    expect(await listTasks(db.pool, workItemId)).toEqual([done]);
    await expect(markTaskDone(db.pool, workItemId, "1.1", SHA)).rejects.toThrow("1.1");
    await expect(markTaskDone(db.pool, workItemId, "9.9", SHA)).rejects.toThrow("9.9");
  });

  it("a re-plan supersedes only the unfinished tasks", async () => {
    const workItemId = await newWorkItem();
    const first = await planAttempt(workItemId);
    await storePlan(db.pool, { workItemId, planAttemptId: first, tasks: [task("1.1", "Parse the words"), task("1.2", "Parse the lookups"), task("1.3", "Parse the books")] });
    const done = await markTaskDone(db.pool, workItemId, "1.1", SHA);

    // The new plan keeps 1.1 as it was, gives 1.2 a new meaning, drops 1.3 and adds 1.4.
    const second = await planAttempt(workItemId);
    const replanned = await storePlan(db.pool, {
      workItemId,
      planAttemptId: second,
      tasks: [task("1.1", "Parse the words"), task("1.2", "Parse the lookups with their usage"), task("1.4", "Merge duplicate lookups")],
    });

    expect(replanned).toEqual([
      done,
      expect.objectContaining({ taskId: "1.2", title: "Parse the lookups with their usage", status: "pending", planAttemptId: second }),
      expect.objectContaining({ taskId: "1.4", title: "Merge duplicate lookups", status: "pending", planAttemptId: second }),
    ]);
    expect(await listTasks(db.pool, workItemId)).toEqual(replanned);

    // The superseded rows keep the history.
    const { rows } = await db.pool.query<{ task_id: string; title: string; status: string }>(
      "SELECT task_id, title, status FROM tasks WHERE work_item_id = $1 ORDER BY id",
      [workItemId],
    );
    expect(rows).toEqual([
      { task_id: "1.1", title: "Parse the words", status: "done" },
      { task_id: "1.2", title: "Parse the lookups", status: "superseded" },
      { task_id: "1.3", title: "Parse the books", status: "superseded" },
      { task_id: "1.2", title: "Parse the lookups with their usage", status: "pending" },
      { task_id: "1.4", title: "Merge duplicate lookups", status: "pending" },
    ]);
  });

  it("allows one live row per task id", async () => {
    const workItemId = await newWorkItem();
    const planAttemptId = await planAttempt(workItemId);
    await storePlan(db.pool, { workItemId, planAttemptId, tasks: [task("1.1", "Parse the words")] });

    await expect(
      db.pool.query("INSERT INTO tasks (work_item_id, task_id, position, title, status, plan_attempt_id) VALUES ($1, '1.1', 2, 'Again', 'pending', $2)", [
        workItemId,
        planAttemptId,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("approvals by kind", () => {
  it("allows one open approval per work item, whatever its kind", async () => {
    const workItemId = await newWorkItem("awaiting-proposal-approval");

    const proposal = await openApproval(db.pool, { workItemId, taskToken: "token-proposal" });
    expect(proposal).toMatchObject({ kind: "proposal", state: "open" });
    await expect(openApproval(db.pool, { workItemId, taskToken: "token-design", kind: "design" })).rejects.toThrow(ApprovalAlreadyOpen);

    await closeApproval(db.pool, workItemId, "miklospocsaji");
    const design = await openApproval(db.pool, { workItemId, taskToken: "token-design", kind: "design" });

    expect(design).toMatchObject({ kind: "design", state: "open", taskToken: "token-design" });
    expect(await findOpenApproval(db.pool, workItemId)).toEqual(design);
    await expect(openApproval(db.pool, { workItemId, taskToken: "token-proposal-2", kind: "proposal" })).rejects.toThrow(ApprovalAlreadyOpen);
  });

  it("refuses an unknown kind", async () => {
    const workItemId = await newWorkItem();

    await expect(
      db.pool.query("INSERT INTO approvals (work_item_id, state, task_token, kind) VALUES ($1, 'open', 'token', 'release')", [workItemId]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("build attempts", () => {
  it("carry a task, a store prefix, a classification and a gates result", async () => {
    const workItemId = await newWorkItem("build");
    const prefix = "work-items/add-build/tasks/1.1/attempts/1";
    const gates = { mode: "green", changeId: "add-build", taskId: "1.1", passed: false, checks: [] };
    const classification = { kind: "bug", evidence: "The task's own test fails on an assertion." };

    const opened = await openAttempt(db.pool, { workItemId, state: "build", role: "implementer", taskId: "1.1", storePrefix: prefix });
    expect(opened).toMatchObject({ taskId: "1.1", storePrefix: prefix, classification: null, gates: null });

    const closed = await closeAttempt(db.pool, opened.id, { outcome: "failed", failureReason: "green", gates });
    expect(closed).toMatchObject({ outcome: "failed", failureReason: "green", gates });

    const classified = await setAttemptClassification(db.pool, opened.id, classification);
    expect(classified).toMatchObject({ id: opened.id, classification, gates });
    expect(await listAttempts(db.pool, workItemId)).toEqual([classified]);
  });

  it("stores a passed attempt's gates with its result", async () => {
    const workItemId = await newWorkItem("build");
    const gates = { mode: "red", changeId: "add-build", taskId: "1.1", passed: true, checks: [] };
    const result = { tests: [{ file: "app/domain/test/words.test.ts", scenario: "Words are counted" }], stubs: [], notes: "" };

    const opened = await openAttempt(db.pool, { workItemId, state: "build", role: "test-author", taskId: "1.1", storePrefix: "work-items/x/1" });
    const closed = await closeAttempt(db.pool, opened.id, { outcome: "succeeded", result, gates });

    expect(closed).toMatchObject({ outcome: "succeeded", result, gates, classification: null });
  });

  it("leaves the task and store prefix empty for an attempt outside the build loop", async () => {
    const workItemId = await newWorkItem("design");

    const opened = await openAttempt(db.pool, { workItemId, state: "design", role: "architect" });

    expect(opened).toMatchObject({ taskId: null, storePrefix: null, classification: null, gates: null });
  });
});

describe("design flaws", () => {
  it("counts design flaws per work item", async () => {
    const workItemId = await newWorkItem("build");
    const other = await newWorkItem("build");
    const issueNumber = nextIssue - 2;

    expect((await findWorkItemByIssue(db.pool, issueNumber))?.designFlaws).toBe(0);

    expect(await incrementDesignFlaws(db.pool, workItemId)).toMatchObject({ id: workItemId, designFlaws: 1 });
    expect(await incrementDesignFlaws(db.pool, workItemId)).toMatchObject({ id: workItemId, designFlaws: 2 });

    expect((await findWorkItemByIssue(db.pool, issueNumber))?.designFlaws).toBe(2);
    expect((await findWorkItemByIssue(db.pool, issueNumber + 1))?.id).toBe(other);
    expect((await findWorkItemByIssue(db.pool, issueNumber + 1))?.designFlaws).toBe(0);
    await expect(incrementDesignFlaws(db.pool, "999999")).rejects.toThrow("999999");
  });
});
