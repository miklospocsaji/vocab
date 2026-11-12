// Open PR (add-build-loop task 3.9): one pull request for the change branch once every task is ticked.
import { listTasks } from "@vocab/factory-ledger";
import { describe, expect, it } from "vitest";
import { openPr } from "../src/open-pr.ts";
import { buildTask, CODE, codeFor, currentWorkItem, TESTS, testsFor, useBuildHarness } from "./build-harness.ts";
import { CHANGE_ID, ISSUE, plannedWorkItem, useWorkItemFixture } from "./work-item-fixture.ts";

const f = useWorkItemFixture("open_pr");
const builds = useBuildHarness(f);

describe("open-pr", { timeout: 60_000 }, () => {
  it("Scenario: Pull request is opened once", async () => {
    const workItem = await plannedWorkItem(f);
    const h = builds.create([TESTS, CODE, testsFor("app/domain/test/books.test.ts", "app/domain/src/books.ts", "Books are imported"), codeFor("app/domain/src/books.ts")]);
    expect((await buildTask(f, h, "1.1")).at(-1)?.kind).toBe("done");
    expect((await buildTask(f, h, "1.2")).at(-1)?.kind).toBe("done");
    expect((await listTasks(f.db.pool, workItem.id)).map((task) => task.status)).toEqual(["done", "done"]);
    const comments = f.forge.comments.length;

    const first = await openPr({ db: f.db.pool, forge: f.forge }, await currentWorkItem(f));
    const second = await openPr({ db: f.db.pool, forge: f.forge }, await currentWorkItem(f));

    expect(first).toMatchObject({ kind: "advance", workItem: { state: "pr-open" } });
    expect(second).toMatchObject({ kind: "advance", workItem: { state: "pr-open" } });
    expect((await currentWorkItem(f)).state).toBe("pr-open");

    // Exactly one pull request, from the change branch into master.
    expect(f.forge.pullRequests).toHaveLength(1);
    const [pr] = f.forge.pullRequests;
    expect(pr).toMatchObject({ head: CHANGE_ID, base: "master" });
    expect(pr?.title).toContain(CHANGE_ID);
    // Its body lists the tasks, each role's cost and the issue.
    const body = pr?.body ?? "";
    expect(body).toContain("1.1");
    expect(body).toContain("Parse the lookups");
    expect(body).toContain("1.2");
    expect(body).toContain("Parse the books");
    for (const role of ["proposal-author", "planner", "test-author", "implementer"]) expect(body).toContain(role);
    expect(body).toMatch(/tokens/);
    expect(body).toMatch(/\$\d+\.\d{2}/);
    expect(body).toContain(`#${String(ISSUE.number)}`);

    // One comment on the issue, linking it.
    expect(f.forge.comments).toHaveLength(comments + 1);
    expect(f.forge.comments.at(-1)).toMatchObject({ issueNumber: ISSUE.number, body: expect.stringContaining(pr?.url ?? "no url") as unknown });
  });

  it("refuses a work item whose tasks are not all done", async () => {
    await plannedWorkItem(f);

    await expect(openPr({ db: f.db.pool, forge: f.forge }, await currentWorkItem(f))).rejects.toThrow(/1\.1/);
    expect(f.forge.pullRequests).toEqual([]);
  });
});
