import type { CloudFormationCustomResourceEvent } from "aws-lambda";
import { createDataApiDb, dataApiConfigFromEnv } from "../db/data-api.ts";
import type { Db } from "../db/db.ts";
import { migrate, type Migration } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";

// The deploy-time migration custom resource (ADR 0006), behind the CDK `Provider`
// framework: returning answers the event, throwing fails it and with it the deploy. Its
// properties carry the synthesised commit, so it runs on every deploy.

const PHYSICAL_ID = "app-migrations";

export interface MigrateDeps {
  readonly db: Db;
  readonly migrations: readonly Migration[];
  /** Drop and recreate the `app` schema first (the test environment). */
  readonly reset: boolean;
}

export interface ProviderResult {
  readonly PhysicalResourceId: string;
  readonly Data?: Record<string, string>;
}

/** Create and Update run the migrations; Delete leaves the database alone. */
export async function onMigrateEvent(event: CloudFormationCustomResourceEvent, deps: MigrateDeps): Promise<ProviderResult> {
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId };
  console.log(`${event.RequestType}: migrating, reset ${String(deps.reset)}`);
  const applied = await migrate(deps.db, deps.migrations, { reset: deps.reset });
  console.log(`Applied ${String(applied.length)} migration(s)`, applied);
  return { PhysicalResourceId: PHYSICAL_ID, Data: { Applied: applied.join(",") } };
}

/** `RESET_DATABASE` is `"true"` or `"false"`; anything else is a configuration error. */
export function resetFromEnv(env: Record<string, string | undefined>): boolean {
  const value = env["RESET_DATABASE"];
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`RESET_DATABASE must be "true" or "false", not ${JSON.stringify(value)}`);
}

export function handler(event: CloudFormationCustomResourceEvent): Promise<ProviderResult> {
  return onMigrateEvent(event, {
    db: createDataApiDb(dataApiConfigFromEnv(process.env)),
    migrations,
    reset: resetFromEnv(process.env),
  });
}
