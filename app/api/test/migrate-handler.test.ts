import type { CloudFormationCustomResourceEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { onMigrateEvent } from "../src/handlers/migrate.ts";
import type { Migration } from "../src/migrate.ts";

const base = {
  ServiceToken: "arn:aws:lambda:eu-central-1:111111111111:function:provider",
  ResponseURL: "https://example.invalid/response",
  StackId: "arn:aws:cloudformation:eu-central-1:111111111111:stack/VocabApp-test/1",
  RequestId: "request-1",
  LogicalResourceId: "Migrations",
  ResourceType: "Custom::Migrations",
  ResourceProperties: { ServiceToken: "token", Commit: "abc123" },
} as const;

const create: CloudFormationCustomResourceEvent = { ...base, RequestType: "Create" };
const update: CloudFormationCustomResourceEvent = {
  ...base,
  RequestType: "Update",
  PhysicalResourceId: "app-migrations",
  OldResourceProperties: { ServiceToken: "token", Commit: "old" },
};
const remove: CloudFormationCustomResourceEvent = { ...base, RequestType: "Delete", PhysicalResourceId: "app-migrations" };

const list: Migration[] = [{ id: "0001-x", sql: "CREATE TABLE app.x (id int)" }];

/** A Db that records every statement; `fail` makes a matching statement throw. */
function stubDb(fail?: RegExp): Db & { sql: string[] } {
  const sql: string[] = [];
  const db: Db & { sql: string[] } = {
    sql,
    query: (statement) => {
      sql.push(statement);
      if (fail?.test(statement) === true) return Promise.reject(new Error("syntax error"));
      return Promise.resolve([]);
    },
    transaction: (work) => work(db),
  };
  return db;
}

describe("migrate custom resource", () => {
  it("Scenario: Create runs the migrations", async () => {
    const db = stubDb();
    const result = await onMigrateEvent(create, { db, migrations: list, reset: false });
    expect(db.sql).toContain("CREATE TABLE app.x (id int)");
    expect(db.sql.some((statement) => statement.startsWith("DROP SCHEMA"))).toBe(false);
    expect(result).toEqual({ PhysicalResourceId: "app-migrations", Data: { Applied: "0001-x" } });
  });

  it("Scenario: Update runs the migrations with reset", async () => {
    const db = stubDb();
    const result = await onMigrateEvent(update, { db, migrations: list, reset: true });
    expect(db.sql[0]).toBe("DROP SCHEMA IF EXISTS app CASCADE");
    expect(db.sql).toContain("CREATE TABLE app.x (id int)");
    expect(result.PhysicalResourceId).toBe("app-migrations");
  });

  it("Scenario: Delete does nothing", async () => {
    const db = stubDb();
    const result = await onMigrateEvent(remove, { db, migrations: list, reset: true });
    expect(db.sql).toEqual([]);
    expect(result).toEqual({ PhysicalResourceId: "app-migrations" });
  });

  it("Scenario: A migration error fails the event", async () => {
    const db = stubDb(/CREATE TABLE app\.x/);
    await expect(onMigrateEvent(create, { db, migrations: list, reset: false })).rejects.toThrow(/0001-x/);
  });

  it("Scenario: RESET_DATABASE sets reset", async () => {
    const { resetFromEnv } = await import("../src/handlers/migrate.ts");
    expect(resetFromEnv({ RESET_DATABASE: "true" })).toBe(true);
    expect(resetFromEnv({ RESET_DATABASE: "false" })).toBe(false);
    expect(() => resetFromEnv({})).toThrow(/RESET_DATABASE/);
  });
});
