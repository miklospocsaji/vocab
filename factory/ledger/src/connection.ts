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

/** Anything that can run one query: the pool, in the worker. */
export interface Queryable {
  query(sql: string): Promise<unknown>;
}

export interface WaitOptions {
  /**
   * How long to keep trying (default 180 s). Aurora resumed in 16 s after 10 minutes paused,
   * and in 76 s after two days (exit run, 2026-11-08).
   */
  timeoutMs?: number;
  /** The pause between attempts (default 2 s). */
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits until the ledger answers `select 1`, retrying while a paused Aurora resumes (design:
 * "The connection retries for up to 180 s while Aurora resumes"). The final error names the
 * cause's code, or "connection timeout", only: `pg`'s messages can carry the host.
 */
export async function waitForLedger(db: Queryable, options: WaitOptions = {}): Promise<void> {
  const { timeoutMs = 180_000, intervalMs = 2_000, now = Date.now, sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      await db.query("select 1");
      return;
    } catch (error) {
      const left = deadline - now();
      // The worker prints only the message; the cause stays for a debugger.
      if (left <= 0) throw new Error(`the ledger did not answer within ${String(Math.round(timeoutMs / 1000))} s (${errorCode(error)})`, { cause: error });
      await sleep(Math.min(intervalMs, left));
    }
  }
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  // pg's connection timeouts carry no code; their messages name no host.
  if (error instanceof Error && /timeout/i.test(error.message)) return "connection timeout";
  return error instanceof Error ? error.name : "unknown error";
}
