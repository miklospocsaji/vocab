// Plan (add-build-loop task 3.5): the planner, validatePlan, the tasks in the ledger, tasks.md on the branch.
import { closeApproval, findWorkItemByIssue, LedgerRecorder, listAttempts, listTasks, type WorkItemRow } from "@vocab/factory-ledger";
import { loadRole, type PlanPaths, type Role } from "@vocab/factory-roles";
import { beforeAll, describe, expect, it } from "vitest";
import { approved, awaitApproval } from "../src/approval.ts";
import { design } from "../src/design.ts";
import { changeFileReader } from "../src/git.ts";
import { MAX_PLAN_ATTEMPTS, plan, type PlanContext } from "../src/plan.ts";
import { createFakeRoleRunner, type FakeStep } from "./fake-role-runner.ts";
import { BOT, CHANGE, changedFiles, git, identityOf, ISSUE, proposedWorkItem, remoteHead, useWorkItemFixture } from "./work-item-fixture.ts";

const f = useWorkItemFixture("plan");

const TASKS_MD = ["# Tasks", "", "## 1. Import", "", "- [ ] 1.1 Parse the lookups", "- [ ] 1.2 Parse the books", ""].join("\n");
const PLAN = {
  tasks: [
    {
      id: "1.1",
      title: "Parse the lookups",
      dependsOn: [],
      files: ["app/domain/src/lookups.ts"],
      scenarios: ["Lookups are imported"],
      tests: ["app/domain/test/lookups.test.ts"],
    },
    {
      id: "1.2",
      title: "Parse the books",
      dependsOn: ["1.1"],
      files: ["app/domain/src/books.ts"],
      scenarios: ["Books are imported"],
      tests: ["app/domain/test/books.test.ts"],
    },
  ],
};
const UNKNOWN_SCENARIO = "Words are counted";
/** A plan that names a scenario the change does not have, and leaves one unassigned. */
const BAD_PLAN = { tasks: [{ ...PLAN.tasks[0], scenarios: [UNKNOWN_SCENARIO] }, PLAN.tasks[1]] };

const PLAN_STEP: FakeStep = { files: { "tasks.md": TASKS_MD }, result: PLAN };
const BAD_STEP: FakeStep = { files: { "tasks.md": TASKS_MD }, result: BAD_PLAN };

let planner: Role;
let planPaths: PlanPaths;

beforeAll(async () => {
  planner = await loadRole("planner");
  planPaths = { implementer: (await loadRole("implementer")).writable, testAuthor: (await loadRole("test-author")).writable };
});

function planContext(steps: FakeStep[]): { ctx: PlanContext; calls: ReturnType<typeof createFakeRoleRunner>["calls"] } {
  const fake = createFakeRoleRunner(new LedgerRecorder(f.db.pool), steps);
  return { ctx: { db: f.db.pool, forge: f.forge, runRole: fake.runRole, planner, planPaths, repo: f.repo, home: f.home, committer: BOT }, calls: fake.calls };
}

async function approvedWorkItem(complexity: string): Promise<WorkItemRow> {
  const transition = await approved({ db: f.db.pool, forge: f.forge, readChangeFile: changeFileReader({ repo: f.repo, home: f.home }) }, await proposedWorkItem(f, complexity));
  if (transition.kind !== "advance") throw new Error(`approved did not advance: ${JSON.stringify(transition)}`);
  return transition.workItem;
}

describe("plan", { timeout: 30_000 }, () => {
  it("Scenario: Plan stores its tasks", async () => {
    const workItem = await approvedWorkItem("small");
    const before = remoteHead(f);
    const { ctx, calls } = planContext([PLAN_STEP]);

    const transition = await plan(ctx, workItem);

    // The execution's next state gets the task ids, in order.
    const stored = await findWorkItemByIssue(f.db.pool, ISSUE.number);
    expect(stored?.state).toBe("build");
    expect(transition).toEqual({ kind: "advance", workItem: stored, result: PLAN, tasks: ["1.1", "1.2"] });
    expect(calls.map((call) => call.role)).toEqual(["planner"]);

    // One ledger row per entry of tasks.json, from the succeeded attempt.
    const [attempt] = (await listAttempts(f.db.pool, workItem.id)).filter((row) => row.role === "planner");
    expect(attempt).toMatchObject({ state: "plan", n: 1, outcome: "succeeded", result: PLAN });
    const tasks = await listTasks(f.db.pool, workItem.id);
    expect(tasks.map(({ taskId, title, dependsOn, files, scenarios, tests, status, planAttemptId }) => ({ taskId, title, dependsOn, files, scenarios, tests, status, planAttemptId }))).toEqual(
      PLAN.tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        dependsOn: task.dependsOn,
        files: task.files,
        scenarios: task.scenarios,
        tests: task.tests,
        status: "pending",
        planAttemptId: attempt?.id,
      })),
    );

    // tasks.md is on the branch, in one commit by the bot that holds nothing else.
    const head = remoteHead(f);
    expect(git(f.remote, "rev-parse", `${head}^`)).toBe(before);
    expect(changedFiles(f, head)).toEqual([`${CHANGE}/tasks.md`]);
    expect(git(f.remote, "show", `${head}:${CHANGE}/tasks.md`)).toBe(TASKS_MD.trimEnd());
    expect(identityOf(f, head)).toBe(`${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`);
  });

  it("retries a plan that fails validatePlan with its problems as evidence", async () => {
    const workItem = await approvedWorkItem("small");
    const { ctx, calls } = planContext([BAD_STEP, PLAN_STEP]);

    const transition = await plan(ctx, workItem);

    expect(transition).toMatchObject({ kind: "advance", tasks: ["1.1", "1.2"] });
    expect(calls[0]?.evidence).toBeUndefined();
    expect(calls[1]?.evidence?.reason).toBe("invalid-result");
    expect(calls[1]?.evidence?.evidence).toContain(`task 1.1 names the scenario "${UNKNOWN_SCENARIO}", which is not in the change`);
    expect(calls[1]?.evidence?.evidence).toContain('the scenario "Lookups are imported" is assigned to no task');

    const attempts = (await listAttempts(f.db.pool, workItem.id)).filter((row) => row.role === "planner");
    expect(attempts.map((row) => [row.n, row.outcome, row.failureReason])).toEqual([
      [1, "failed", "invalid-result"],
      [2, "succeeded", null],
    ]);
    // Only the accepted plan's tasks are stored.
    expect((await listTasks(f.db.pool, workItem.id)).map((task) => task.planAttemptId)).toEqual([attempts[1]?.id, attempts[1]?.id]);
  });

  it("escalates after three rejected plans, storing and pushing nothing", async () => {
    const workItem = await approvedWorkItem("small");
    const before = remoteHead(f);
    const comments = f.forge.comments.length;
    const { ctx, calls } = planContext([BAD_STEP, BAD_STEP, BAD_STEP]);

    const transition = await plan(ctx, workItem);

    const stored = await findWorkItemByIssue(f.db.pool, ISSUE.number);
    expect(stored?.state).toBe("escalated");
    expect(transition).toEqual({ kind: "escalate", workItem: stored, reason: expect.stringContaining("plan") as unknown });
    expect(MAX_PLAN_ATTEMPTS).toBe(3);
    expect(calls).toHaveLength(3);
    expect(await listTasks(f.db.pool, workItem.id)).toEqual([]);
    expect(remoteHead(f)).toBe(before);
    expect(f.forge.comments).toHaveLength(comments + 1);
    expect(f.forge.comments.at(-1)?.body).toContain(UNKNOWN_SCENARIO);
  });

  it("plans a large change once the owner has approved its design", async () => {
    const workItem = await approvedWorkItem("large");
    const architect = await loadRole("architect");
    const designReviewer = await loadRole("design-reviewer");
    const designFake = createFakeRoleRunner(new LedgerRecorder(f.db.pool), [
      { files: { "design.md": "# Design\n\n## Overview\n\nRead vocab.db.\n" }, result: { summary: "Read vocab.db.", contracts: [], adrNeeded: [], openQuestions: [] } },
    ]);
    const designed = await design({ db: f.db.pool, forge: f.forge, runRole: designFake.runRole, architect, designReviewer, repo: f.repo, home: f.home, committer: BOT }, workItem);
    if (designed.kind !== "advance") throw new Error("design did not advance");
    await awaitApproval({ db: f.db.pool, forge: f.forge }, designed.workItem, "token", "design");

    // While the design approval is open, Plan refuses to run.
    await expect(plan(planContext([PLAN_STEP]).ctx, designed.workItem)).rejects.toThrow(/approval/);

    await closeApproval(f.db.pool, workItem.id, "miklospocsaji");
    const transition = await plan(planContext([PLAN_STEP]).ctx, (await findWorkItemByIssue(f.db.pool, ISSUE.number)) as WorkItemRow);

    expect(transition).toMatchObject({ kind: "advance", workItem: { state: "build" }, tasks: ["1.1", "1.2"] });
  });

  it("refuses a medium change that has not been through Design", async () => {
    const workItem = await approvedWorkItem("medium");
    const { ctx, calls } = planContext([PLAN_STEP]);

    await expect(plan(ctx, workItem)).rejects.toThrow(/medium/);
    expect(calls).toEqual([]);
  });

  it("does nothing for a work item past Plan, returning its unfinished tasks", async () => {
    const workItem = await approvedWorkItem("small");
    await plan(planContext([PLAN_STEP]).ctx, workItem);
    const head = remoteHead(f);
    const { ctx, calls } = planContext([]);

    const transition = await plan(ctx, (await findWorkItemByIssue(f.db.pool, ISSUE.number)) as WorkItemRow);

    expect(transition).toMatchObject({ kind: "advance", workItem: { state: "build" }, tasks: ["1.1", "1.2"] });
    expect(calls).toEqual([]);
    expect(remoteHead(f)).toBe(head);
  });
});
