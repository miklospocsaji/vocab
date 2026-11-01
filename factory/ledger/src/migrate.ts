/**
 * Applies the ledger's plain SQL migrations (ADR 0003) to the connection's current schema.
 * Files in `migrations/` run in name order, each once; `schema_migrations` records them.
 * Everything runs in one transaction under an advisory lock, so concurrent runners
 * serialise and a failing migration leaves nothing behind.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type pg from "pg";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../migrations");

/** Returns the versions it applied, in order; empty when the schema is up to date. */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('factory-ledger-migrate:' || current_schema()))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((row) => row.version));

    const applied: string[] = [];
    for (const file of files) {
      const version = basename(file, ".sql");
      if (done.has(version)) continue;
      await client.query(await readFile(join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      applied.push(version);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
