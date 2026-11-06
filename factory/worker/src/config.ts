/**
 * The worker's command line and its configuration from the environment. The environment is
 * set by the task definition (`add-cloud-proposal-run`); some of it is secret, so errors name
 * a variable and never its value.
 */
import { parseArgs } from "node:util";
import { DATABASE_URL_VAR } from "@vocab/factory-ledger";

/** The states this worker runs; `add-cloud-proposal-run` adds the rest. */
export const WORKER_STATES = ["intake", "proposal"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export const USAGE = `Usage: factory-worker <${WORKER_STATES.join("|")}> --issue <n>\n`;

export type ParsedArgs = { ok: true; state: WorkerState; issueNumber: number } | { ok: false; message: string };

/** Reads `<state> --issue <n>`; never throws. */
export function parseWorkerArgs(argv: string[]): ParsedArgs {
  let positionals: string[];
  let issue: string | undefined;
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { issue: { type: "string" } } });
    positionals = parsed.positionals;
    issue = parsed.values.issue;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const [state, ...rest] = positionals;
  if (state === undefined) return { ok: false, message: "no state given" };
  if (rest.length > 0) return { ok: false, message: `unexpected argument ${rest[0] ?? ""}` };
  if (!isWorkerState(state)) return { ok: false, message: `unknown state ${state} (known: ${WORKER_STATES.join(", ")})` };
  const issueNumber = Number(issue);
  if (issue === undefined || !/^[1-9][0-9]*$/.test(issue) || !Number.isSafeInteger(issueNumber)) {
    return { ok: false, message: "--issue must be an issue number" };
  }
  return { ok: true, state, issueNumber };
}

function isWorkerState(value: string): value is WorkerState {
  return (WORKER_STATES as readonly string[]).includes(value);
}

export const ENV = {
  repository: "FACTORY_GITHUB_REPOSITORY",
  appId: "FACTORY_GITHUB_APP_ID",
  installationId: "FACTORY_GITHUB_APP_INSTALLATION_ID",
  slug: "FACTORY_GITHUB_APP_SLUG",
  privateKey: "FACTORY_GITHUB_APP_PRIVATE_KEY",
} as const;

export interface WorkerConfig {
  databaseUrl: string;
  owner: string;
  repo: string;
  app: { appId: number; installationId: number; slug: string; privateKey: string };
}

/** A missing or invalid setting; the message names the variable only. */
export class WorkerConfigError extends Error {
  override readonly name = "WorkerConfigError";
}

export function workerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const databaseUrl = required(env, DATABASE_URL_VAR);

  const repository = required(env, ENV.repository);
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repository);
  const [, owner, repo] = match ?? [];
  if (owner === undefined || repo === undefined) throw new WorkerConfigError(`${ENV.repository} must be <owner>/<repo>`);

  const slug = required(env, ENV.slug);
  if (!/^[a-z0-9-]+$/.test(slug)) throw new WorkerConfigError(`${ENV.slug} must be the App's slug`);

  // Some secret stores keep a PEM's line breaks as `\n`.
  const privateKey = required(env, ENV.privateKey).replaceAll("\\n", "\n");
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----\s*$/.test(privateKey.trim() + "\n")) {
    throw new WorkerConfigError(`${ENV.privateKey} must be a PEM private key`);
  }

  return {
    databaseUrl,
    owner,
    repo,
    app: { appId: positiveInteger(env, ENV.appId), installationId: positiveInteger(env, ENV.installationId), slug, privateKey },
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new WorkerConfigError(`${name} is not set`);
  return value;
}

function positiveInteger(env: Record<string, string | undefined>, name: string): number {
  const value = required(env, name).trim();
  const n = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n)) throw new WorkerConfigError(`${name} must be a positive integer`);
  return n;
}
