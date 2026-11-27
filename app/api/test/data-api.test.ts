import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  DatabaseResumingException,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { describe, expect, it } from "vitest";
import { createDataApiDb, type DataApiDeps } from "../src/db/data-api.ts";

// A stubbed RDSDataClient: no AWS. Each sent command is recorded, and `respond` answers it.

const config = {
  resourceArn: "arn:aws:rds:eu-central-1:111111111111:cluster:test",
  secretArn: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test",
  database: "vocab_test",
};

type Sent = { command: string; input: Record<string, unknown> };

function stub(respond: (sent: Sent) => unknown) {
  const sent: Sent[] = [];
  let clock = 0;
  const sleeps: number[] = [];
  const deps: DataApiDeps = {
    client: {
      // async, so that a `respond` that throws rejects, as the SDK does.
      // eslint-disable-next-line @typescript-eslint/require-await
      async send(command) {
        const entry = { command: command.constructor.name, input: command.input as unknown as Record<string, unknown> };
        sent.push(entry);
        return respond(entry);
      },
    },
    now: () => clock,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  return { deps, sent, sleeps };
}

const resuming = () => new DatabaseResumingException({ message: "resuming", $metadata: {} });

describe("createDataApiDb", () => {
  it("Scenario: Parameters are sent typed", async () => {
    const { deps, sent } = stub(() => ({}));
    const db = createDataApiDb(config, deps);
    await db.query("INSERT INTO t VALUES (:s, :i, :d, :b, :n)", { s: "x", i: 7, d: 0.5, b: false, n: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.command).toBe(ExecuteStatementCommand.name);
    expect(sent[0]?.input).toEqual({
      resourceArn: config.resourceArn,
      secretArn: config.secretArn,
      database: config.database,
      sql: "INSERT INTO t VALUES (:s, :i, :d, :b, :n)",
      parameters: [
        { name: "s", value: { stringValue: "x" } },
        { name: "i", value: { longValue: 7 } },
        { name: "d", value: { doubleValue: 0.5 } },
        { name: "b", value: { booleanValue: false } },
        { name: "n", value: { isNull: true } },
      ],
      formatRecordsAs: "JSON",
    });
  });

  it("Scenario: JSON records become rows", async () => {
    const { deps } = stub(() => ({ formattedRecords: JSON.stringify([{ a: 1, b: null }, { a: 2, b: "y" }]) }));
    const db = createDataApiDb(config, deps);
    expect(await db.query("SELECT a, b FROM t")).toEqual([
      { a: 1, b: null },
      { a: 2, b: "y" },
    ]);
  });

  it("Scenario: A statement without records returns no rows", async () => {
    const { deps } = stub(() => ({ numberOfRecordsUpdated: 3 }));
    expect(await createDataApiDb(config, deps).query("UPDATE t SET a = 1")).toEqual([]);
  });

  it("Scenario: A resuming database is retried until it answers", async () => {
    let calls = 0;
    const { deps, sent, sleeps } = stub(() => {
      calls += 1;
      if (calls < 4) throw resuming();
      return { formattedRecords: "[{\"ok\":1}]" };
    });
    expect(await createDataApiDb(config, deps).query("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
    expect(sent).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it("Scenario: A database still resuming after 30 s fails with the error", async () => {
    const { deps, sleeps } = stub(() => {
      throw resuming();
    });
    await expect(createDataApiDb(config, deps).query("SELECT 1")).rejects.toBeInstanceOf(DatabaseResumingException);
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeLessThanOrEqual(30_000);
    expect(waited).toBeGreaterThan(25_000);
  });

  it("Scenario: Other errors are not retried", async () => {
    const { deps, sent } = stub(() => {
      throw new Error("syntax error");
    });
    await expect(createDataApiDb(config, deps).query("SELEC 1")).rejects.toThrow("syntax error");
    expect(sent).toHaveLength(1);
  });

  it("Scenario: A transaction begins, passes its id and commits", async () => {
    const { deps, sent } = stub((entry) => (entry.command === BeginTransactionCommand.name ? { transactionId: "tx-1" } : {}));
    const db = createDataApiDb(config, deps);
    const result = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES (1)");
      await tx.transaction((inner) => inner.query("INSERT INTO t VALUES (2)"));
      return "done";
    });
    expect(result).toBe("done");
    expect(sent.map((entry) => entry.command)).toEqual([
      BeginTransactionCommand.name,
      ExecuteStatementCommand.name,
      ExecuteStatementCommand.name,
      CommitTransactionCommand.name,
    ]);
    expect(sent[0]?.input).toEqual({ resourceArn: config.resourceArn, secretArn: config.secretArn, database: config.database });
    expect(sent[1]?.input["transactionId"]).toBe("tx-1");
    expect(sent[2]?.input["transactionId"]).toBe("tx-1");
    expect(sent[3]?.input).toEqual({ resourceArn: config.resourceArn, secretArn: config.secretArn, transactionId: "tx-1" });
  });

  it("Scenario: A transaction rolls back on error", async () => {
    const { deps, sent } = stub((entry) => {
      if (entry.command === BeginTransactionCommand.name) return { transactionId: "tx-2" };
      if (entry.command === ExecuteStatementCommand.name) throw new Error("duplicate key");
      return {};
    });
    await expect(createDataApiDb(config, deps).transaction((tx) => tx.query("INSERT INTO t VALUES (1)"))).rejects.toThrow(
      "duplicate key",
    );
    expect(sent.map((entry) => entry.command)).toEqual([
      BeginTransactionCommand.name,
      ExecuteStatementCommand.name,
      RollbackTransactionCommand.name,
    ]);
    expect(sent[2]?.input).toEqual({ resourceArn: config.resourceArn, secretArn: config.secretArn, transactionId: "tx-2" });
  });

  it("Scenario: Beginning a transaction on a resuming database is retried", async () => {
    let begins = 0;
    const { deps, sent } = stub((entry) => {
      if (entry.command === BeginTransactionCommand.name) {
        begins += 1;
        if (begins < 2) throw resuming();
        return { transactionId: "tx-3" };
      }
      return {};
    });
    await createDataApiDb(config, deps).transaction((tx) => tx.query("SELECT 1"));
    expect(sent.map((entry) => entry.command)).toEqual([
      BeginTransactionCommand.name,
      BeginTransactionCommand.name,
      ExecuteStatementCommand.name,
      CommitTransactionCommand.name,
    ]);
  });
});
