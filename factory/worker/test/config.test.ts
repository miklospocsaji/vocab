/**
 * The worker's configuration from its environment (add-factory-worker task 1.13). Errors name
 * the variable, never its value, since some of them are secrets. In the cloud the ledger comes
 * from the RDS secret in FACTORY_LEDGER_SECRET; locally and in the Docker tests from
 * FACTORY_DATABASE_URL (add-cloud-proposal-run, exit run of task 4.1).
 */
import { connectionFromSecret } from "@vocab/factory-ledger";
import { describe, expect, it } from "vitest";
import { parseWorkerArgs, WorkerConfigError, workerConfig } from "../src/config.ts";

const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeybody\n-----END RSA PRIVATE KEY-----\n";

const LEDGER_PASSWORD = "ledger-Pa55word-from-RDS";
const LEDGER_HOST = "factory-ledger.cluster-abc123.eu-central-1.rds.amazonaws.com";
/** The shape of the secret RDS generates for the cluster's master user. */
const LEDGER_SECRET = JSON.stringify({
  engine: "postgres",
  host: LEDGER_HOST,
  port: 5432,
  username: "factory",
  password: LEDGER_PASSWORD,
  dbname: "factory",
  dbClusterIdentifier: "factory-ledger",
});

const ENV = {
  FACTORY_DATABASE_URL: "postgres://factory:s3cret@ledger:5432/factory",
  FACTORY_GITHUB_REPOSITORY: "miklospocsaji/vocab",
  FACTORY_GITHUB_APP_ID: "5586098",
  FACTORY_GITHUB_APP_INSTALLATION_ID: "177972181",
  FACTORY_GITHUB_APP_SLUG: "vocab-factory",
  FACTORY_GITHUB_APP_PRIVATE_KEY: KEY,
};

describe("workerConfig", () => {
  it("reads the ledger, the repository and the GitHub App from the environment", () => {
    expect(workerConfig(ENV)).toEqual({
      ledger: { connectionString: ENV.FACTORY_DATABASE_URL },
      owner: "miklospocsaji",
      repo: "vocab",
      app: { appId: 5586098, installationId: 177972181, slug: "vocab-factory", privateKey: KEY },
    });
  });

  it("builds the ledger connection from FACTORY_LEDGER_SECRET, over verified TLS", () => {
    const cloud = { ...ENV, FACTORY_DATABASE_URL: undefined };

    const { ledger } = workerConfig({ ...cloud, FACTORY_LEDGER_SECRET: LEDGER_SECRET });

    expect(ledger).toEqual(connectionFromSecret(LEDGER_SECRET));
    expect(ledger).not.toHaveProperty("connectionString");
  });

  it("prefers FACTORY_LEDGER_SECRET when FACTORY_DATABASE_URL is also set", () => {
    expect(workerConfig({ ...ENV, FACTORY_LEDGER_SECRET: LEDGER_SECRET }).ledger).toEqual(connectionFromSecret(LEDGER_SECRET));
  });

  it("names both ledger variables when neither is set", () => {
    const env = { ...ENV, FACTORY_DATABASE_URL: undefined };

    expect(() => workerConfig(env)).toThrow(WorkerConfigError);
    expect(() => workerConfig(env)).toThrow(/FACTORY_LEDGER_SECRET.*FACTORY_DATABASE_URL|FACTORY_DATABASE_URL.*FACTORY_LEDGER_SECRET/);
  });

  it("refuses an invalid FACTORY_LEDGER_SECRET, naming it without any value", () => {
    const cloud = { ...ENV, FACTORY_DATABASE_URL: undefined };
    const broken = JSON.stringify({ ...(JSON.parse(LEDGER_SECRET) as Record<string, unknown>), port: "five" });

    let error: unknown;
    try {
      workerConfig({ ...cloud, FACTORY_LEDGER_SECRET: broken });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(WorkerConfigError);
    const message = (error as Error).message;
    expect(message).toContain("FACTORY_LEDGER_SECRET");
    expect(message).not.toContain(LEDGER_PASSWORD);
    expect(message).not.toContain(LEDGER_HOST);
  });

  it("accepts a private key with escaped newlines, as some secret stores hand it out", () => {
    const escaped = KEY.replaceAll("\n", "\\n");
    expect(workerConfig({ ...ENV, FACTORY_GITHUB_APP_PRIVATE_KEY: escaped }).app.privateKey).toBe(KEY);
  });

  it.each(Object.keys(ENV))("names %s when it is missing, without any value", (name) => {
    const env: Record<string, string | undefined> = { ...ENV, [name]: undefined };

    const error = (() => {
      try {
        workerConfig(env);
      } catch (e) {
        return e;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(WorkerConfigError);
    const message = (error as Error).message;
    expect(message).toContain(name);
    for (const value of Object.values(ENV)) expect(message).not.toContain(value);
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("secretkeybody");
  });

  it.each([
    ["FACTORY_GITHUB_REPOSITORY", "vocab"],
    ["FACTORY_GITHUB_REPOSITORY", "a/b/c"],
    ["FACTORY_GITHUB_APP_ID", "abc"],
    ["FACTORY_GITHUB_APP_INSTALLATION_ID", "-1"],
    ["FACTORY_GITHUB_APP_PRIVATE_KEY", "not a key"],
  ])("refuses an invalid %s (%s)", (name, value) => {
    expect(() => workerConfig({ ...ENV, [name]: value })).toThrow(WorkerConfigError);
    expect(() => workerConfig({ ...ENV, [name]: value })).toThrow(name);
  });
});

describe("parseWorkerArgs", () => {
  it("reads the state and the issue number", () => {
    expect(parseWorkerArgs(["proposal", "--issue", "12"])).toEqual({ ok: true, state: "proposal", issueNumber: 12 });
    expect(parseWorkerArgs(["--issue=7", "intake"])).toEqual({ ok: true, state: "intake", issueNumber: 7 });
  });

  it("names an unknown state", () => {
    const parsed = parseWorkerArgs(["deploy", "--issue", "1"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/unknown state deploy/);
  });

  it.each([[[]], [["intake"]], [["intake", "--issue", "0"]], [["intake", "--issue", "1.5"]], [["intake", "--issue"]], [["intake", "--issue", "1", "--x"]]])(
    "refuses %j",
    (argv) => {
      expect(parseWorkerArgs(argv).ok).toBe(false);
    },
  );
});
