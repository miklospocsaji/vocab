import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  DatabaseResumingException,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
  type Field,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
import type { Db, Row, Scalar } from "./db.ts";

// The adapter used in AWS (ADR 0007): Aurora through the Data API, over HTTPS with IAM. The
// Lambda runs outside the VPC and holds no connection.

export interface DataApiConfig {
  /** The cluster's ARN. */
  readonly resourceArn: string;
  /** The ARN of the secret holding the environment role's username and password. */
  readonly secretArn: string;
  /** The environment's database, such as `vocab_test`. */
  readonly database: string;
}

type DataApiCommand =
  | ExecuteStatementCommand
  | BeginTransactionCommand
  | CommitTransactionCommand
  | RollbackTransactionCommand;

/** What the adapter needs from outside, replaceable in tests. */
export interface DataApiDeps {
  readonly client?: { send(command: DataApiCommand): Promise<unknown> };
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** How long a paused cluster may take to wake (about 15 s) before a statement fails. */
const RESUME_TIMEOUT_MS = 30_000;
const FIRST_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

function field(value: Scalar): Field {
  if (value === null) return { isNull: true };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
}

function parameters(params: Record<string, Scalar> | undefined): SqlParameter[] {
  return Object.entries(params ?? {}).map(([name, value]) => ({ name, value: field(value) }));
}

function sdkClient(): NonNullable<DataApiDeps["client"]> {
  const rds = new RDSDataClient({});
  // `send` is overloaded per command; every DataApiCommand is one of its commands.
  return { send: (command) => rds.send(command as ExecuteStatementCommand) };
}

export function createDataApiDb(config: DataApiConfig, deps: DataApiDeps = {}): Db {
  const client = deps.client ?? sdkClient();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { resourceArn, secretArn, database } = config;

  /** Sends a command, retrying while the cluster resumes, for up to 30 s. */
  async function send<T>(command: DataApiCommand): Promise<T> {
    const deadline = now() + RESUME_TIMEOUT_MS;
    let delay = FIRST_DELAY_MS;
    for (;;) {
      try {
        return (await client.send(command)) as T;
      } catch (error) {
        const left = deadline - now();
        if (!(error instanceof DatabaseResumingException) || left <= 0) throw error;
        await sleep(Math.min(delay, left));
        delay = Math.min(delay * 2, MAX_DELAY_MS);
      }
    }
  }

  function make(transactionId: string | undefined): Db {
    const db: Db = {
      async query<T extends Row = Row>(sql: string, params?: Record<string, Scalar>): Promise<T[]> {
        const output = await send<{ formattedRecords?: string }>(
          new ExecuteStatementCommand({
            resourceArn,
            secretArn,
            database,
            sql,
            parameters: parameters(params),
            formatRecordsAs: "JSON",
            ...(transactionId === undefined ? {} : { transactionId }),
          }),
        );
        return output.formattedRecords === undefined ? [] : (JSON.parse(output.formattedRecords) as T[]);
      },
      async transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
        if (transactionId !== undefined) return work(db);
        const begun = await send<{ transactionId?: string }>(new BeginTransactionCommand({ resourceArn, secretArn, database }));
        const id = begun.transactionId;
        if (id === undefined) throw new Error("The Data API began a transaction without an id");
        let result: T;
        try {
          result = await work(make(id));
        } catch (error) {
          // The work's error is the one that matters; a failed rollback times out on its own.
          await send(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId: id })).catch(() => undefined);
          throw error;
        }
        await send(new CommitTransactionCommand({ resourceArn, secretArn, transactionId: id }));
        return result;
      },
    };
    return db;
  }

  return make(undefined);
}
