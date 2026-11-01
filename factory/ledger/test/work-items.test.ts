import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { ChangeIdTaken, createWorkItem, findWorkItemByChangeId, findWorkItemByIssue, setWorkItemState } from "../src/queries.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase("work_items");
  await migrate(db.pool);
  return () => db.close();
});

describe("work items", () => {
  it("creates a work item and finds it by issue number", async () => {
    const created = await createWorkItem(db.pool, {
      issueNumber: 12,
      changeId: "add-import-kindle-vocab-db",
      branch: "add-import-kindle-vocab-db",
      state: "intake",
    });

    expect(created).toMatchObject({
      issueNumber: 12,
      changeId: "add-import-kindle-vocab-db",
      branch: "add-import-kindle-vocab-db",
      state: "intake",
    });
    expect(created.id).toEqual(expect.any(String));
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    expect(await findWorkItemByIssue(db.pool, 12)).toEqual(created);
  });

  it("finds nothing for an issue without a work item", async () => {
    expect(await findWorkItemByIssue(db.pool, 999)).toBeUndefined();
  });

  it("rejects a second work item with the same change id", async () => {
    await createWorkItem(db.pool, { issueNumber: 20, changeId: "fix-duplicate-lookups", branch: "fix-duplicate-lookups", state: "intake" });

    const second = createWorkItem(db.pool, { issueNumber: 21, changeId: "fix-duplicate-lookups", branch: "fix-duplicate-lookups", state: "intake" });

    await expect(second).rejects.toThrow(ChangeIdTaken);
    await expect(second).rejects.toThrow("fix-duplicate-lookups");
    expect(await findWorkItemByIssue(db.pool, 21)).toBeUndefined();
  });

  it("finds a work item by change id", async () => {
    const created = await createWorkItem(db.pool, { issueNumber: 30, changeId: "add-review-queue", branch: "add-review-queue", state: "intake" });

    expect(await findWorkItemByChangeId(db.pool, "add-review-queue")).toEqual(created);
    expect(await findWorkItemByChangeId(db.pool, "add-nothing-like-it")).toBeUndefined();
  });

  it("moves a work item to a new state and bumps updated_at", async () => {
    const created = await createWorkItem(db.pool, { issueNumber: 31, changeId: "add-word-export", branch: "add-word-export", state: "intake" });

    const moved = await setWorkItemState(db.pool, created.id, "proposal");

    expect(moved).toMatchObject({ id: created.id, state: "proposal", createdAt: created.createdAt });
    expect(moved.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    expect(await findWorkItemByIssue(db.pool, 31)).toEqual(moved);
    await expect(setWorkItemState(db.pool, "999999", "proposal")).rejects.toThrow("999999");
  });
});
