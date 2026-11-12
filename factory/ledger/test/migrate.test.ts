import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase("migrate");
  return () => db.close();
});

async function tables(): Promise<string[]> {
  const { rows } = await db.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
  );
  return rows.map((row) => row.table_name);
}

describe("migrate", () => {
  it("applies each migration once and is idempotent", async () => {
    expect(await migrate(db.pool)).toEqual(["0001_init", "0002_cloud", "0003_build"]);
    expect(await tables()).toEqual(["approvals", "attempts", "events", "messages", "schema_migrations", "tasks", "work_items"]);

    expect(await migrate(db.pool)).toEqual([]);
    const { rows } = await db.pool.query<{ version: string }>("SELECT version FROM schema_migrations");
    expect(rows.map((row) => row.version).sort()).toEqual(["0001_init", "0002_cloud", "0003_build"]);
  });
});
