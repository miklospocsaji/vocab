/**
 * `connectionFromSecret` (add-cloud-proposal-run task 2.5): the ledger's connection in the
 * cloud, from the secret RDS generates, over TLS verified against the committed CA bundle.
 */
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { connectionFromSecret, RDS_CA_BUNDLE_PATH, RDS_CA_BUNDLE_SHA256, waitForLedger } from "../src/connection.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PASSWORD = "s3cr3t-Pa55word-from-RDS";

/** The shape of the secret RDS generates for a cluster's master user. */
const SECRET = {
  engine: "postgres",
  host: "factory-ledger.cluster-abc123.eu-central-1.rds.amazonaws.com",
  port: 5432,
  username: "factory",
  password: PASSWORD,
  dbname: "factory",
  dbClusterIdentifier: "factory-ledger",
};

function certificates(pem: string): X509Certificate[] {
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((block) => new X509Certificate(block));
}

describe("connectionFromSecret", () => {
  it("builds a TLS config that verifies against the committed CA bundle", () => {
    const config = connectionFromSecret(JSON.stringify(SECRET));

    expect(config).toMatchObject({ host: SECRET.host, port: 5432, user: "factory", password: PASSWORD, database: "factory" });
    expect(config).not.toHaveProperty("connectionString");
    const ssl = config.ssl;
    if (typeof ssl !== "object") throw new Error("no TLS options");
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity).toBeUndefined();
    expect(ssl.ca).toBe(readFileSync(RDS_CA_BUNDLE_PATH, "utf8"));
  });

  it("commits the RDS CA bundle with the recorded SHA-256", () => {
    expect(RDS_CA_BUNDLE_PATH).toBe(resolve(REPO_ROOT, "factory/ledger/certs/rds-global-bundle.pem"));
    const bundle = readFileSync(RDS_CA_BUNDLE_PATH);
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(RDS_CA_BUNDLE_SHA256);

    // The worker image trusts the same bundle (ADR 0010).
    const dockerfile = readFileSync(resolve(REPO_ROOT, "factory/worker/Dockerfile"), "utf8");
    expect(dockerfile).toContain(`--checksum=sha256:${RDS_CA_BUNDLE_SHA256}`);

    // Root and intermediate CAs only, every one of them a CA.
    const certs = certificates(bundle.toString("utf8"));
    expect(certs.length).toBeGreaterThan(10);
    for (const cert of certs) expect(cert.ca).toBe(true);
    expect(certs.some((cert) => cert.subject.includes("eu-central-1"))).toBe(true);
  });

  it("rejects a secret that is not the RDS shape, without echoing it", () => {
    const broken = [
      "not json",
      JSON.stringify({ ...SECRET, host: undefined }),
      JSON.stringify({ ...SECRET, port: "five" }),
      JSON.stringify({ ...SECRET, password: "" }),
      JSON.stringify({ ...SECRET, dbname: undefined }),
    ];
    for (const secret of broken) {
      let message = "";
      try {
        connectionFromSecret(secret);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `accepted ${secret.replace(PASSWORD, "***")}`).toMatch(/ledger secret/);
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain(SECRET.host);
    }
  });
});

/** A ledger that refuses `failures` queries, then answers; time passes only through `sleep`. */
function resumingLedger(failures: number, error: Error = connectionRefused()) {
  let clock = 0;
  const queries: string[] = [];
  const sleeps: number[] = [];
  return {
    queries,
    sleeps,
    db: {
      query(sql: string): Promise<unknown> {
        queries.push(sql);
        return queries.length <= failures ? Promise.reject(error) : Promise.resolve({ rows: [] });
      },
    },
    options: {
      now: () => clock,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    },
  };
}

/** What `pg` throws while Aurora is paused: a message naming the host, and a code. */
function connectionRefused(): Error {
  return Object.assign(new Error(`connect ECONNREFUSED ${SECRET.host}:5432`), { code: "ECONNREFUSED" });
}

describe("waitForLedger", () => {
  it("returns once the ledger answers, pausing between attempts while it resumes", async () => {
    const ledger = resumingLedger(3);

    await waitForLedger(ledger.db, { ...ledger.options, intervalMs: 2_000 });

    expect(ledger.queries).toHaveLength(4);
    expect(new Set(ledger.queries)).toEqual(new Set(["select 1"]));
    expect(ledger.sleeps).toEqual([2_000, 2_000, 2_000]);
  });

  it("does not pause when the ledger answers at once", async () => {
    const ledger = resumingLedger(0);

    await waitForLedger(ledger.db, ledger.options);

    expect(ledger.queries).toHaveLength(1);
    expect(ledger.sleeps).toEqual([]);
  });

  it("gives up after the timeout, naming the error's code but not the host", async () => {
    const ledger = resumingLedger(Number.POSITIVE_INFINITY);

    const failure = waitForLedger(ledger.db, { ...ledger.options, timeoutMs: 60_000, intervalMs: 2_000 });

    await expect(failure).rejects.toThrow(/ledger.*60 s.*ECONNREFUSED/);
    await expect(failure).rejects.not.toThrow(SECRET.host);
    // About 60 s of attempts, and none after the deadline.
    expect(ledger.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(60_000);
    expect(ledger.queries.length).toBeGreaterThanOrEqual(30);
  });

  it("waits 180 s by default, 2 s apart", async () => {
    // Aurora took 76 s to resume after two days paused (exit run, 2026-11-08).
    const ledger = resumingLedger(Number.POSITIVE_INFINITY);

    await expect(waitForLedger(ledger.db, ledger.options)).rejects.toThrow(/180 s/);

    expect(new Set(ledger.sleeps)).toEqual(new Set([2_000]));
    expect(ledger.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(180_000);
  });

  it("names a connection timeout, which pg throws with no code", async () => {
    // What pg throws when connectionTimeoutMillis passes while Aurora resumes.
    const ledger = resumingLedger(Number.POSITIVE_INFINITY, new Error("Connection terminated due to connection timeout"));

    await expect(waitForLedger(ledger.db, { ...ledger.options, timeoutMs: 10_000 })).rejects.toThrow(/\(connection timeout\)/);
  });
});
