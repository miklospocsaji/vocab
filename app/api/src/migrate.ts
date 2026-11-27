import type { Db } from "./db/db.ts";

// The migration runner (ADR 0007). Every app table lives in the `app` schema, which the
// environment's role owns; `app.schema_migrations` records what has been applied.

export interface Migration {
  /** Sorts in apply order, such as `0001-create-trajectories`. */
  readonly id: string;
  /** One SQL statement, run as one `Db.query` call. */
  readonly sql: string;
}

export interface MigrateOptions {
  /** Drop and recreate the `app` schema first, losing all its data (the test environment). */
  readonly reset: boolean;
}

/**
 * Applies, in list order, each migration not yet recorded, each in its own transaction with
 * its record. Returns the ids it applied. A failing migration throws, naming it; the ones
 * before it stay applied.
 */
export async function migrate(db: Db, migrations: readonly Migration[], options: MigrateOptions): Promise<string[]> {
  if (options.reset) await db.query("DROP SCHEMA IF EXISTS app CASCADE");
  await db.query("CREATE SCHEMA IF NOT EXISTS app");
  await db.query(
    "CREATE TABLE IF NOT EXISTS app.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const rows = await db.query<{ id: string }>("SELECT id FROM app.schema_migrations");
  const done = new Set(rows.map((row) => row.id));
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    try {
      await db.transaction(async (tx) => {
        await tx.query(migration.sql);
        await tx.query("INSERT INTO app.schema_migrations (id) VALUES (:id)", { id: migration.id });
      });
    } catch (error) {
      throw new Error(`Migration ${migration.id} failed`, { cause: error });
    }
    applied.push(migration.id);
  }
  return applied;
}
