import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { createPgliteDb } from "../src/db/pglite.ts";

let pglite: PGlite;
let db: Db;

beforeAll(async () => {
  pglite = await PGlite.create();
  db = createPgliteDb(pglite);
  await db.query("CREATE TABLE t (id int PRIMARY KEY, label text, flag boolean, ratio double precision)");
});

afterAll(async () => {
  await pglite.close();
});

describe("createPgliteDb", () => {
  it("Scenario: A query with parameters returns rows", async () => {
    const rows = await db.query<{ total: number; label: string }>("SELECT :a::int + :b::int AS total, :label AS label", {
      a: 2,
      b: 3,
      label: "five",
    });
    expect(rows).toEqual([{ total: 5, label: "five" }]);
  });

  it("Scenario: Null, booleans and numbers round-trip", async () => {
    await db.query("INSERT INTO t (id, label, flag, ratio) VALUES (:id, :label, :flag, :ratio)", {
      id: 1,
      label: null,
      flag: true,
      ratio: 0.25,
    });
    await db.query("INSERT INTO t (id, label, flag, ratio) VALUES (:id, :label, :flag, :ratio)", {
      id: 2,
      label: "two",
      flag: false,
      ratio: -3,
    });
    const rows = await db.query("SELECT id, label, flag, ratio FROM t WHERE id IN (1, 2) ORDER BY id");
    expect(rows).toEqual([
      { id: 1, label: null, flag: true, ratio: 0.25 },
      { id: 2, label: "two", flag: false, ratio: -3 },
    ]);
  });

  it("Scenario: A transaction commits its work", async () => {
    const result = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO t (id, label) VALUES (10, 'kept')");
      return "done";
    });
    expect(result).toBe("done");
    expect(await db.query("SELECT label FROM t WHERE id = 10")).toEqual([{ label: "kept" }]);
  });

  it("Scenario: A failing statement in a transaction rolls it back", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO t (id, label) VALUES (20, 'gone')");
        await tx.query("INSERT INTO t (id, label) VALUES (20, 'duplicate')");
      }),
    ).rejects.toThrow(/duplicate key/);
    expect(await db.query("SELECT id FROM t WHERE id = 20")).toEqual([]);
  });

  it("Scenario: A transaction inside a transaction joins it", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.query("INSERT INTO t (id) VALUES (30)");
        });
        throw new Error("outer fails");
      }),
    ).rejects.toThrow("outer fails");
    expect(await db.query("SELECT id FROM t WHERE id = 30")).toEqual([]);
  });
});
