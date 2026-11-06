/**
 * The worker's configuration from its environment (add-factory-worker task 1.13). Errors name
 * the variable, never its value, since some of them are secrets.
 */
import { describe, expect, it } from "vitest";
import { parseWorkerArgs, WorkerConfigError, workerConfig } from "../src/config.ts";

const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeybody\n-----END RSA PRIVATE KEY-----\n";

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
      databaseUrl: ENV.FACTORY_DATABASE_URL,
      owner: "miklospocsaji",
      repo: "vocab",
      app: { appId: 5586098, installationId: 177972181, slug: "vocab-factory", privateKey: KEY },
    });
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
    const parsed = parseWorkerArgs(["design", "--issue", "1"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/unknown state design/);
  });

  it.each([[[]], [["intake"]], [["intake", "--issue", "0"]], [["intake", "--issue", "1.5"]], [["intake", "--issue"]], [["intake", "--issue", "1", "--x"]]])(
    "refuses %j",
    (argv) => {
      expect(parseWorkerArgs(argv).ok).toBe(false);
    },
  );
});
