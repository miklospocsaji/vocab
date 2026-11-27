import { DatabaseResumingException, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { onBootstrapEvent, type BootstrapDeps, type BootstrapEvent } from "../src/base/db-bootstrap/handler.ts";

const clusterArn = "arn:aws:rds:eu-central-1:111111111111:cluster:vocab";
const masterSecretArn = "arn:aws:secretsmanager:eu-central-1:111111111111:secret:master";
const testSecretArn = "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test";
const prodSecretArn = "arn:aws:secretsmanager:eu-central-1:111111111111:secret:prod";
const testPassword = "T3".repeat(16);
const prodPassword = "P4".repeat(16);

const properties = {
  ServiceToken: "token",
  ClusterArn: clusterArn,
  MasterSecretArn: masterSecretArn,
  Databases: [
    { Name: "vocab_test", SecretArn: testSecretArn },
    { Name: "vocab_prod", SecretArn: prodSecretArn },
  ],
};

const common = {
  ServiceToken: "token",
  ResponseURL: "https://example.invalid/response",
  StackId: "arn:aws:cloudformation:eu-central-1:111111111111:stack/VocabShared/1",
  RequestId: "request-1",
  LogicalResourceId: "DatabaseBootstrap",
  ResourceType: "Custom::DatabaseBootstrap",
  ResourceProperties: properties,
};

const create: BootstrapEvent = { ...common, RequestType: "Create" as const };
const update = {
  ...common,
  RequestType: "Update" as const,
  PhysicalResourceId: "database-bootstrap",
  OldResourceProperties: properties,
};
const remove = { ...common, RequestType: "Delete" as const, PhysicalResourceId: "database-bootstrap" };

interface Options {
  secrets?: Record<string, string>;
  existingDatabases?: string[];
  failOn?: RegExp;
  resumingTimes?: number;
}

function stub(options: Options = {}) {
  const secrets = options.secrets ?? {
    [testSecretArn]: JSON.stringify({ username: "vocab_test", password: testPassword }),
    [prodSecretArn]: JSON.stringify({ username: "vocab_prod", password: prodPassword }),
  };
  const statements: { input: Record<string, unknown> }[] = [];
  const secretReads: string[] = [];
  let resuming = options.resumingTimes ?? 0;
  const deps: BootstrapDeps = {
    rds: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async send(command: ExecuteStatementCommand) {
        const input = command.input as unknown as Record<string, unknown>;
        statements.push({ input });
        if (resuming > 0) {
          resuming -= 1;
          throw new DatabaseResumingException({ message: "resuming", $metadata: {} });
        }
        const sql = String(input["sql"]);
        if (options.failOn?.test(sql) === true) throw new Error(`syntax error near '${testPassword}'`);
        if (sql.startsWith("SELECT datname FROM pg_database")) {
          const name = /'([a-z_]+)'/.exec(sql)?.[1] ?? "";
          const rows = (options.existingDatabases ?? []).includes(name) ? [{ datname: name }] : [];
          return { formattedRecords: JSON.stringify(rows) };
        }
        return {};
      },
    },
    secrets: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async send(command: GetSecretValueCommand) {
        const id = String(command.input.SecretId);
        secretReads.push(id);
        const value = secrets[id];
        if (value === undefined) throw new Error(`No secret ${id}`);
        return { SecretString: value };
      },
    },
    sleep: () => Promise.resolve(),
  };
  return { deps, statements, secretReads, sql: () => statements.map((statement) => String(statement.input["sql"])) };
}

let logs: MockInstance[];

beforeEach(() => {
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything the handler wrote to the console, as one string. */
function logged(): string {
  return logs.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join("\n");
}

describe("database bootstrap handler", () => {
  it("Scenario: Create reads both environment secrets and runs the statements with the master secret", async () => {
    const { deps, statements, secretReads, sql } = stub();
    const result = await onBootstrapEvent(create, deps);
    expect(result).toEqual({ PhysicalResourceId: "database-bootstrap" });
    expect(secretReads.sort()).toEqual([prodSecretArn, testSecretArn].sort());
    for (const statement of statements) {
      expect(statement.input).toMatchObject({ resourceArn: clusterArn, secretArn: masterSecretArn, database: "postgres" });
      expect(statement.input["parameters"]).toBeUndefined();
    }
    expect(sql()).toContain("CREATE DATABASE vocab_test OWNER vocab_test");
    expect(sql()).toContain("CREATE DATABASE vocab_prod OWNER vocab_prod");
    expect(sql().filter((statement) => statement.includes(testPassword))).toHaveLength(1);
    expect(sql().filter((statement) => statement.includes(prodPassword))).toHaveLength(1);
  });

  it("Scenario: Update skips creating databases that exist and still aligns the roles", async () => {
    const { deps, sql } = stub({ existingDatabases: ["vocab_test", "vocab_prod"] });
    await onBootstrapEvent(update, deps);
    expect(sql().some((statement) => statement.startsWith("CREATE DATABASE"))).toBe(false);
    expect(sql().some((statement) => statement.includes(`PASSWORD '${testPassword}'`))).toBe(true);
    expect(sql()).toContain("REVOKE CONNECT ON DATABASE vocab_prod FROM PUBLIC");
  });

  it("Scenario: Delete does nothing", async () => {
    const { deps, statements, secretReads } = stub();
    expect(await onBootstrapEvent(remove, deps)).toEqual({ PhysicalResourceId: "database-bootstrap" });
    expect(statements).toEqual([]);
    expect(secretReads).toEqual([]);
  });

  it("Scenario: A password that is not 32 letters and digits fails the deploy", async () => {
    const bad = `${"x".repeat(31)}'`;
    const { deps, statements } = stub({
      secrets: {
        [testSecretArn]: JSON.stringify({ username: "vocab_test", password: bad }),
        [prodSecretArn]: JSON.stringify({ username: "vocab_prod", password: prodPassword }),
      },
    });
    const failure = onBootstrapEvent(create, deps);
    await expect(failure).rejects.toThrow(/vocab_test/);
    await failure.catch((error: unknown) => {
      expect((error as Error).message).not.toContain(bad);
    });
    expect(statements).toEqual([]);
  });

  it("Scenario: A secret for another user fails the deploy", async () => {
    const { deps } = stub({
      secrets: {
        [testSecretArn]: JSON.stringify({ username: "vocab_prod", password: testPassword }),
        [prodSecretArn]: JSON.stringify({ username: "vocab_prod", password: prodPassword }),
      },
    });
    await expect(onBootstrapEvent(create, deps)).rejects.toThrow(/vocab_test/);
  });

  it("Scenario: A failing statement fails the deploy without revealing a password", async () => {
    const { deps } = stub({ failOn: /CREATE ROLE/ });
    const failure = onBootstrapEvent(create, deps);
    await expect(failure).rejects.toThrow(/role vocab_test/);
    await failure.catch((error: unknown) => {
      expect((error as Error).message).not.toContain(testPassword);
    });
  });

  it("Scenario: A resuming cluster is retried", async () => {
    const { deps, sql } = stub({ resumingTimes: 2 });
    await onBootstrapEvent(create, deps);
    expect(sql().filter((statement) => statement.startsWith("CREATE DATABASE"))).toHaveLength(2);
  });

  it("Scenario: The handler never logs the event's secrets or the SQL", async () => {
    const { deps } = stub();
    await onBootstrapEvent(create, deps);
    const { deps: failing } = stub({ failOn: /CREATE DATABASE/ });
    await onBootstrapEvent(create, failing).catch(() => undefined);
    const output = logged();
    expect(output).not.toContain(testPassword);
    expect(output).not.toContain(prodPassword);
    expect(output).not.toMatch(/CREATE|ALTER|REVOKE|GRANT|SELECT/);
  });
});
