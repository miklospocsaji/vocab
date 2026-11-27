import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createPgliteDb } from "../src/db/pglite.ts";
import { migrate, type Migration } from "../src/migrate.ts";
import { migrations as shipped } from "../src/migrations/index.ts";

const first: Migration = { id: "0001-notes", sql: "CREATE TABLE app.notes (id int PRIMARY KEY, body text)" };
const second: Migration = { id: "0002-tags", sql: "CREATE TABLE app.tags (id int PRIMARY KEY)" };
const third: Migration = { id: "0003-note-tag", sql: "ALTER TABLE app.notes ADD COLUMN tag int" };

let pglite: PGlite;
let db: Db;

beforeEach(async () => {
  pglite = await PGlite.create();
  db = createPgliteDb(pglite);
});

afterEach(async () => {
  await pglite.close();
});

async function recorded(): Promise<string[]> {
  const rows = await db.query<{ id: string }>("SELECT id FROM app.schema_migrations ORDER BY id");
  return rows.map((row) => row.id);
}

async function tables(): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'app' ORDER BY table_name",
  );
  return rows.map((row) => row.name);
}

describe("migrate", () => {
  it("Scenario: A fresh database gets every migration and its records", async () => {
    expect(await migrate(db, [first, second], { reset: false })).toEqual(["0001-notes", "0002-tags"]);
    expect(await recorded()).toEqual(["0001-notes", "0002-tags"]);
    expect(await tables()).toEqual(["notes", "schema_migrations", "tags"]);
    const [row] = await db.query<{ applied: boolean }>(
      "SELECT bool_and(applied_at IS NOT NULL) AS applied FROM app.schema_migrations",
    );
    expect(row?.applied).toBe(true);
  });

  it("Scenario: A second run applies nothing", async () => {
    await migrate(db, [first, second], { reset: false });
    expect(await migrate(db, [first, second], { reset: false })).toEqual([]);
    expect(await recorded()).toEqual(["0001-notes", "0002-tags"]);
  });

  it("Scenario: A new migration at the end is applied alone", async () => {
    await migrate(db, [first, second], { reset: false });
    expect(await migrate(db, [first, second, third], { reset: false })).toEqual(["0003-note-tag"]);
    expect(await recorded()).toEqual(["0001-notes", "0002-tags", "0003-note-tag"]);
  });

  it("Scenario: Reset drops the app schema's tables and data and applies everything again", async () => {
    await migrate(db, [first], { reset: false });
    await db.query("INSERT INTO app.notes (id, body) VALUES (1, 'old')");
    await db.query("CREATE TABLE app.leftover (id int)");
    expect(await migrate(db, [first, second], { reset: true })).toEqual(["0001-notes", "0002-tags"]);
    expect(await tables()).toEqual(["notes", "schema_migrations", "tags"]);
    expect(await db.query("SELECT * FROM app.notes")).toEqual([]);
    expect(await recorded()).toEqual(["0001-notes", "0002-tags"]);
  });

  it("Scenario: A failing migration leaves earlier ones recorded and itself unrecorded", async () => {
    const broken: Migration = { id: "0002-broken", sql: "CREATE TABLE app.notes (id int)" };
    await expect(migrate(db, [first, broken, third], { reset: false })).rejects.toThrow(/0002-broken/);
    expect(await recorded()).toEqual(["0001-notes"]);
    expect(await tables()).toEqual(["notes", "schema_migrations"]);
  });

  it("Scenario: The shipped migrations apply to a fresh database", async () => {
    expect(await migrate(db, shipped, { reset: true })).toEqual(shipped.map((migration) => migration.id));
    expect(await tables()).toContain("schema_migrations");
  });
});
