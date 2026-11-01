import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { ChangeIdTaken, createWorkItem, findWorkItemByIssue } from "../src/queries.ts";
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
});
