// The design-flaw path (add-build-loop task 3.9): step, Design, Plan and step again, with fake roles.
import { findWorkItemByIssue, LedgerRecorder, listTasks, type WorkItemRow } from "@vocab/factory-ledger";
import { loadRole, type Role } from "@vocab/factory-roles";
import { beforeAll, describe, expect, it } from "vitest";
import { approved } from "../src/approval.ts";
import { design } from "../src/design.ts";
import { changeFileReader } from "../src/git.ts";
import { plan } from "../src/plan.ts";
import { step } from "../src/step.ts";
import { buildTask, classified, currentWorkItem, codeFor, testsFor, useBuildHarness } from "./build-harness.ts";
import { createFakeRoleRunner, type FakeStep } from "./fake-role-runner.ts";
import { BOT, CHANGE, CHANGE_ID, git, ISSUE, planPaths, planStep, proposedWorkItem, remoteHead, useWorkItemFixture } from "./work-item-fixture.ts";

const f = useWorkItemFixture("design_flaw");
const builds = useBuildHarness(f);

const task = (id: string, title: string, name: string, scenarios: string[], dependsOn: string[] = []) => ({
  id,
  title,
  dependsOn,
  files: [`app/domain/src/${name}.ts`],
  scenarios,
  tests: [`app/domain/test/${name}.test.ts`],
});
const T1 = task("1.1", "Parse the lookups", "lookups", ["Lookups are imported"]);
const T2 = task("1.2", "Parse the books", "books", ["Books are imported"], ["1.1"]);
const T3 = task("1.3", "Store the import", "store", [], ["1.2"]);
const T3_NEW = task("1.3", "Store the import in one transaction", "import", [], ["1.2"]);
const T4 = task("1.4", "Report what was imported", "report", [], ["1.3"]);

const lines = (...entries: string[]) => ["# Tasks", "", "## 1. Import", "", ...entries, ""].join("\n");
const TASKS_MD = lines("- [ ] 1.1 Parse the lookups", "- [ ] 1.2 Parse the books", "- [ ] 1.3 Store the import");
const REPLANNED_MD = lines("- [x] 1.1 Parse the lookups", "- [x] 1.2 Parse the books", "- [ ] 1.3 Store the import in one transaction", "- [ ] 1.4 Report what was imported");

const DESIGN_RESULT = { summary: "Read vocab.db with node:sqlite.", contracts: [], adrNeeded: [], openQuestions: [] };
const architectStep = (overview: string): FakeStep => ({ files: { "design.md": `# Design\n\n## Overview\n\n${overview}\n` }, result: DESIGN_RESULT });
const APPROVE: FakeStep = { result: { verdict: "approve", findings: [] } };
const FLAW = "The design stores each lookup on its own, so a failed import leaves half of the lookups behind; it needs one transaction.";

const buildOf = (t: typeof T1) => [testsFor(t.tests[0] ?? "", t.files[0] ?? "", t.scenarios[0] ?? t.title), codeFor(t.files[0] ?? "")];

let architect: Role;
let designReviewer: Role;
let planner: Role;

beforeAll(async () => {
  architect = await loadRole("architect");
  designReviewer = await loadRole("design-reviewer");
  planner = await loadRole("planner");
});

function roles(steps: FakeStep[]) {
  return createFakeRoleRunner(new LedgerRecorder(f.db.pool), steps);
}

/** A `medium` change through Approved, Design with the reviewer's approval, and a three-task Plan. */
async function plannedMediumWorkItem(): Promise<WorkItemRow> {
  const ctx = { db: f.db.pool, forge: f.forge };
  const routed = await approved({ ...ctx, readChangeFile: changeFileReader({ repo: f.repo, home: f.home }) }, await proposedWorkItem(f, "medium"));
  if (routed.kind !== "advance") throw new Error("approved did not advance");
  const designed = await design({ ...ctx, runRole: roles([architectStep("Store each lookup."), APPROVE]).runRole, architect, designReviewer, repo: f.repo, home: f.home, committer: BOT }, routed.workItem);
  if (designed.kind !== "advance") throw new Error("design did not advance");
  const planned = await plan(
    { ...ctx, runRole: roles([planStep(TASKS_MD, { tasks: [T1, T2, T3] })]).runRole, planner, planPaths: await planPaths(), repo: f.repo, home: f.home, committer: BOT },
    designed.workItem,
  );
  if (planned.kind !== "advance") throw new Error("plan did not advance");
  return planned.workItem;
}

describe("design flaws", { timeout: 120_000 }, () => {
  it("Scenario: Design flaw re-plans the unfinished tasks", async () => {
    const workItem = await plannedMediumWorkItem();
    const h = builds.create([...buildOf(T1), ...buildOf(T2), testsFor("app/domain/test/store.test.ts", "app/domain/src/store.ts", "Store the import"), { ...codeFor("app/domain/src/store.ts"), outcome: "failed", reason: "green", output: "AssertionError: expected 3 lookups, got 2" }], [classified("design-flaw", FLAW)]);
    expect((await buildTask(f, h, "1.1")).at(-1)?.kind).toBe("done");
    expect((await buildTask(f, h, "1.2")).at(-1)?.kind).toBe("done");
    const done = Object.fromEntries((await listTasks(f.db.pool, workItem.id)).map((row) => [row.taskId, row.doneCommit]));

    // Task 1.3 fails with a design flaw: the work item goes back to Design.
    const flawed = await buildTask(f, h, "1.3");
    expect(flawed.at(-1)).toMatchObject({ kind: "design-flaw", workItem: { state: "design", designFlaws: 1 } });

    // The architect runs with the evidence, then the reviewer.
    const designRoles = roles([architectStep("Store the whole import in one transaction."), APPROVE]);
    const redesigned = await design(
      { db: f.db.pool, forge: f.forge, runRole: designRoles.runRole, architect, designReviewer, repo: f.repo, home: f.home, committer: BOT },
      await currentWorkItem(f),
    );
    expect(redesigned).toMatchObject({ kind: "advance", route: "plan", workItem: { state: "plan" } });
    expect(designRoles.calls.map((call) => call.role)).toEqual(["architect", "design-reviewer"]);
    expect(designRoles.calls[0]?.evidence).toEqual({ reason: "design-flaw", evidence: expect.stringContaining(FLAW) as unknown });
    expect(designRoles.calls[1]?.evidence).toBeUndefined();

    // The planner re-plans; the ticked tasks stay ticked and keep their commits.
    const replanned = await plan(
      { db: f.db.pool, forge: f.forge, runRole: roles([planStep(REPLANNED_MD, { tasks: [T1, T2, T3_NEW, T4] })]).runRole, planner, planPaths: await planPaths(), repo: f.repo, home: f.home, committer: BOT },
      (await findWorkItemByIssue(f.db.pool, ISSUE.number)) as WorkItemRow,
    );
    expect(replanned).toMatchObject({ kind: "advance", workItem: { state: "build" }, tasks: ["1.3", "1.4"] });
    const tasksMd = git(f.remote, "show", `${remoteHead(f)}:${CHANGE}/tasks.md`);
    expect(tasksMd).toContain("- [x] 1.1 Parse the lookups");
    expect(tasksMd).toContain("- [x] 1.2 Parse the books");
    expect((await listTasks(f.db.pool, workItem.id)).map((row) => [row.taskId, row.title, row.status, row.doneCommit])).toEqual([
      ["1.1", "Parse the lookups", "done", done["1.1"]],
      ["1.2", "Parse the books", "done", done["1.2"]],
      ["1.3", "Store the import in one transaction", "pending", null],
      ["1.4", "Report what was imported", "pending", null],
    ]);

    // Tasks 1.1 and 1.2 are not rebuilt; the loop continues with the new 1.3, from its test author.
    const calls = h.build.calls.length;
    expect(await step(h.ctx, await currentWorkItem(f), "1.1")).toMatchObject({ kind: "done" });
    expect(await step(h.ctx, await currentWorkItem(f), "1.2")).toMatchObject({ kind: "done" });
    expect(h.build.calls).toHaveLength(calls);
    h.build.script(...buildOf(T3_NEW));
    expect((await buildTask(f, h, "1.3")).at(-1)?.kind).toBe("done");
    const fresh = h.build.calls.slice(calls);
    expect(fresh.map((call) => [call.next.role, call.input.task.title])).toEqual([
      ["test-author", "Store the import in one transaction"],
      ["implementer", "Store the import in one transaction"],
    ]);
    expect(fresh[0]?.input.evidence).toBeUndefined();
    expect(CHANGE_ID).toBe(workItem.changeId);
  });

  it("escalates the third design flaw of a work item", async () => {
    const workItem = await plannedMediumWorkItem();
    await f.db.pool.query("UPDATE work_items SET design_flaws = 2 WHERE id = $1", [workItem.id]);
    const h = builds.create([...buildOf(T1).slice(0, 1), { ...codeFor("app/domain/src/lookups.ts"), outcome: "failed", reason: "green", output: "AssertionError" }], [classified("design-flaw", FLAW)]);
    const comments = f.forge.comments.length;

    const results = await buildTask(f, h, "1.1");

    expect(results.at(-1)).toMatchObject({ kind: "escalate", workItem: { state: "escalated" } });
    expect(f.forge.comments).toHaveLength(comments + 1);
    expect(f.forge.comments.at(-1)?.body).toContain(FLAW);
  });
});
