/**
 * The ledger's connection in the cloud (ADR 0003, amended 2026-11-06): the secret RDS
 * generates for the cluster's master user, injected by ECS as JSON, and TLS verified against
 * the RDS CA bundle committed next to this package. The secret's values never appear in an
 * error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";
import { z } from "zod";

/** The ECS secret the worker reads the ledger's credentials from. */
export const LEDGER_SECRET_VAR = "FACTORY_LEDGER_SECRET";

/** From https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem; a new one is a deliberate change. */
export const RDS_CA_BUNDLE_PATH = resolve(import.meta.dirname, "../certs/rds-global-bundle.pem");
/** Also the checksum the worker image's Dockerfile verifies. */
export const RDS_CA_BUNDLE_SHA256 = "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b";

/** The fields of an RDS-generated secret that the connection needs; RDS adds others. */
const RdsSecret = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().min(1),
  password: z.string().min(1),
  dbname: z.string().min(1),
});

export function connectionFromSecret(secret: string): pg.PoolConfig {
  let json: unknown;
  try {
    json = JSON.parse(secret);
  } catch {
    throw new Error("the ledger secret is not JSON");
  }
  const parsed = RdsSecret.safeParse(json);
  if (!parsed.success) {
    // Names the fields only, never their values.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ");
    throw new Error(`the ledger secret lacks a valid ${fields}`);
  }
  const { host, port, username, password, dbname } = parsed.data;
  return {
    host,
    port,
    user: username,
    password,
    database: dbname,
    ssl: { ca: readFileSync(RDS_CA_BUNDLE_PATH, "utf8"), rejectUnauthorized: true },
  };
}
