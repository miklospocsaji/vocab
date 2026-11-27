import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapStatements, runBootstrap } from "../src/base/db-bootstrap/statements.ts";

const testPassword = "A".repeat(16) + "b1".repeat(8);
const prodPassword = "Z9".repeat(16);
const passwords = { vocab_test: testPassword, vocab_prod: prodPassword };

describe("bootstrapStatements", () => {
  it("Scenario: Each role is created when missing and altered otherwise, with its secret's password", () => {
    const plan = bootstrapStatements(["vocab_test", "vocab_prod"], passwords);
    expect(plan.map((step) => step.name)).toEqual(["vocab_test", "vocab_prod"]);
    const [test] = plan;
    expect(test?.role).toContain("IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vocab_test')");
    expect(test?.role).toContain(`CREATE ROLE vocab_test LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${testPassword}'`);
    expect(test?.role).toContain(`ALTER ROLE vocab_test WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${testPassword}'`);
    expect(test?.role).not.toContain(prodPassword);
  });

  it("Scenario: Each database is owned by its role, with CONNECT revoked from PUBLIC", () => {
    const [test] = bootstrapStatements(["vocab_test"], passwords);
    expect(test?.exists).toBe("SELECT datname FROM pg_database WHERE datname = 'vocab_test'");
    expect(test?.createDatabase).toBe("CREATE DATABASE vocab_test OWNER vocab_test");
    expect(test?.secure).toEqual([
      "ALTER DATABASE vocab_test OWNER TO vocab_test",
      "REVOKE CONNECT ON DATABASE vocab_test FROM PUBLIC",
    ]);
  });

  it("Scenario: A password that is not 32 letters and digits is refused, without echoing it", () => {
    for (const bad of ["short1", `${"a".repeat(31)}'`, `${"a".repeat(31)}$`, "a".repeat(33)]) {
      let message = "";
      try {
        bootstrapStatements(["vocab_test"], { vocab_test: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/vocab_test/);
      expect(message).not.toContain(bad);
    }
  });

  it("Scenario: A missing password is refused", () => {
    expect(() => bootstrapStatements(["vocab_test"], {})).toThrow(/vocab_test/);
  });

  it("Scenario: A name that is not a plain identifier is refused", () => {
    expect(() => bootstrapStatements(["vocab-test"], { "vocab-test": testPassword })).toThrow(/vocab-test/);
    expect(() => bootstrapStatements(["Vocab"], { Vocab: testPassword })).toThrow(/Vocab/);
  });
});

describe("the bootstrap on PGlite", () => {
  let pg: PGlite;
  const execute = async (sql: string) => (await pg.query<Record<string, unknown>>(sql)).rows;
  const one = async <T>(sql: string): Promise<T> => (await pg.query<T>(sql)).rows[0] as T;

  beforeAll(async () => {
    pg = await PGlite.create();
  });

  afterAll(async () => {
    await pg.close();
  });

  it("Scenario: The bootstrap creates the roles and databases", async () => {
    await runBootstrap(bootstrapStatements(["vocab_test", "vocab_prod"], passwords), execute);
    for (const name of ["vocab_test", "vocab_prod"]) {
      const role = await one<{ login: boolean; createdb: boolean; createrole: boolean; superuser: boolean; scram: boolean }>(
        `SELECT rolcanlogin AS login, rolcreatedb AS createdb, rolcreaterole AS createrole, rolsuper AS superuser,
                rolpassword LIKE 'SCRAM-SHA-256$%' AS scram
           FROM pg_authid WHERE rolname = '${name}'`,
      );
      expect(role).toEqual({ login: true, createdb: false, createrole: false, superuser: false, scram: true });
      const database = await one<{ owner: string; acl: string }>(
        `SELECT pg_get_userbyid(datdba) AS owner, datacl::text AS acl FROM pg_database WHERE datname = '${name}'`,
      );
      expect(database.owner).toBe(name);
      // PUBLIC's entry ("=…/owner") keeps no CONNECT ("c").
      const publicEntry = database.acl.replace(/[{}]/g, "").split(",").find((entry) => entry.startsWith("="));
      expect(publicEntry ?? "=").not.toMatch(/^=[^/]*c/);
    }
  });

  it("Scenario: The bootstrap runs again without error and aligns a changed password", async () => {
    const before = await one<{ hash: string }>("SELECT rolpassword AS hash FROM pg_authid WHERE rolname = 'vocab_test'");
    const changed = { ...passwords, vocab_test: "Q7".repeat(16) };
    await runBootstrap(bootstrapStatements(["vocab_test", "vocab_prod"], changed), execute);
    const after = await one<{ hash: string }>("SELECT rolpassword AS hash FROM pg_authid WHERE rolname = 'vocab_test'");
    expect(after.hash).not.toBe(before.hash);
    const count = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_database WHERE datname IN ('vocab_test', 'vocab_prod')",
    );
    expect(count.n).toBe(2);
  });
});
