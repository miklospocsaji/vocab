import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { HealthResponse } from "@vocab/contracts";
import { createDataApiDb, dataApiConfigFromEnv } from "../db/data-api.ts";
import type { Db } from "../db/db.ts";

// GET /health (change add-app-foundations): proves the API reaches its database.

export interface HealthResult extends APIGatewayProxyStructuredResultV2 {
  readonly statusCode: 200 | 503;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Runs `SELECT 1`: 200 when it works, 503 with `database: "unavailable"` when it throws. */
export async function checkHealth(db: Db, commit: string): Promise<HealthResult> {
  let database: HealthResponse["database"] = "ok";
  try {
    await db.query("SELECT 1 AS one");
  } catch (error) {
    console.error("The health check's SELECT 1 failed", error);
    database = "unavailable";
  }
  const body: HealthResponse = HealthResponse.parse({ status: "ok", database, commit });
  return {
    statusCode: database === "ok" ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

// Built once per container, on the first request.
let db: Db | undefined;

export async function handler(): Promise<HealthResult> {
  db ??= createDataApiDb(dataApiConfigFromEnv(process.env));
  return checkHealth(db, process.env["COMMIT"] ?? "unknown");
}
