import { describe, expect, it } from "vitest";
import { HealthResponse } from "../../contracts/src/index.ts";
import type { Db } from "../src/db/db.ts";
import { checkHealth } from "../src/handlers/health.ts";

function stubDb(query: Db["query"]): Db & { sql: string[] } {
  const sql: string[] = [];
  const db: Db & { sql: string[] } = {
    sql,
    query: (statement, params) => {
      sql.push(statement);
      return query(statement, params);
    },
    transaction: (work) => work(db),
  };
  return db;
}

describe("GET /health", () => {
  it("Scenario: A reachable database answers 200 ok", async () => {
    const db = stubDb(() => Promise.resolve([{ one: 1 }] as never));
    const response = await checkHealth(db, "abc123");
    expect(db.sql).toEqual(["SELECT 1 AS one"]);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    const body = HealthResponse.parse(JSON.parse(response.body));
    expect(body).toEqual({ status: "ok", database: "ok", commit: "abc123" });
  });

  it("Scenario: An unreachable database answers 503 unavailable", async () => {
    const db = stubDb(() => Promise.reject(new Error("resuming")));
    const response = await checkHealth(db, "abc123");
    expect(response.statusCode).toBe(503);
    const body = HealthResponse.parse(JSON.parse(response.body));
    expect(body).toEqual({ status: "ok", database: "unavailable", commit: "abc123" });
  });
});
