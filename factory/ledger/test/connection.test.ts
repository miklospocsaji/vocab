/**
 * `connectionFromSecret` (add-cloud-proposal-run task 2.5): the ledger's connection in the
 * cloud, from the secret RDS generates, over TLS verified against the committed CA bundle.
 */
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { connectionFromSecret, RDS_CA_BUNDLE_PATH, RDS_CA_BUNDLE_SHA256 } from "../src/connection.ts";

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
