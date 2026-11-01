/**
 * Test helper: a fresh Postgres schema per test file, on the database FACTORY_DATABASE_URL
 * names. Unset or unreachable is a failure with instructions, never a skip.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { databaseUrl, DATABASE_URL_VAR } from "./env.ts";

export interface TestDatabase {
  /** Connections whose `search_path` is the test schema only. */
  pool: pg.Pool;
  schema: string;
  /** Drops the schema and closes the pool. */
  close(): Promise<void>;
}

export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const url = databaseUrl();
  const schema = `test_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `cannot reach the ledger at ${DATABASE_URL_VAR} (${error instanceof Error ? error.message : String(error)}). Is it running? Start it with \`pnpm db:up\`.`,
      { cause: error },
    );
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path="${schema}"`, max: 4 });
  return {
    pool,
    schema,
    async close() {
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}
