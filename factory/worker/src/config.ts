/**
 * The worker's command line and its configuration from the environment. The environment is
 * set by the task definition (`add-cloud-proposal-run`); some of it is secret, so errors name
 * a variable and never its value.
 */
import { parseArgs } from "node:util";
import { DATABASE_URL_VAR } from "@vocab/factory-ledger";
import { ESCALATION_REASONS, type EscalationReason } from "@vocab/factory-orchestrator";

/** The states this worker runs: one per state machine state (add-cloud-proposal-run). */
export const WORKER_STATES = ["intake", "proposal", "await-approval", "approve", "approved", "escalate"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export const USAGE = [
  "Usage: factory-worker <state> --issue <n> [options]",
  "  intake --issue <n> [--execution <arn>]",
  "  proposal --issue <n>",
  "  await-approval --issue <n>          (the task token in FACTORY_TASK_TOKEN)",
  "  approve --issue <n> --by <login>",
  "  approved --issue <n>",
  `  escalate --issue <n> --reason <${ESCALATION_REASONS.join("|")}>`,
  "",
].join("\n");

/** The options each state takes besides `--issue`, and whether it needs them. */
const OPTIONS: Record<WorkerState, Partial<Record<"execution" | "by" | "reason", "optional" | "required">>> = {
  intake: { execution: "optional" },
  proposal: {},
  "await-approval": {},
  approve: { by: "required" },
  approved: {},
  escalate: { reason: "required" },
};

const EXECUTION_ARN = /^arn:aws[a-z-]*:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{1,80}$/;
/** A GitHub login: alphanumerics and single hyphens, at most 39 characters. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export interface WorkerArgs {
  state: WorkerState;
  issueNumber: number;
  /** intake: the execution running it. */
  executionArn?: string;
  /** approve: the login that approved, verified as the owner's by the webhook. */
  by?: string;
  /** escalate: why, as a fixed code. */
  reason?: EscalationReason;
}

export type ParsedArgs = ({ ok: true } & WorkerArgs) | { ok: false; message: string };

/** Reads `<state> --issue <n>` and the state's options; never throws. */
export function parseWorkerArgs(argv: string[]): ParsedArgs {
  let positionals: string[];
  let values: { issue?: string | undefined; execution?: string | undefined; by?: string | undefined; reason?: string | undefined };
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { issue: { type: "string" }, execution: { type: "string" }, by: { type: "string" }, reason: { type: "string" } },
    });
    positionals = parsed.positionals;
    values = parsed.values;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const [state, ...rest] = positionals;
  if (state === undefined) return { ok: false, message: "no state given" };
  if (rest.length > 0) return { ok: false, message: `unexpected argument ${rest[0] ?? ""}` };
  if (!isWorkerState(state)) return { ok: false, message: `unknown state ${state} (known: ${WORKER_STATES.join(", ")})` };
  const { issue } = values;
  const issueNumber = Number(issue);
  if (issue === undefined || !/^[1-9][0-9]*$/.test(issue) || !Number.isSafeInteger(issueNumber)) {
    return { ok: false, message: "--issue must be an issue number" };
  }

  const options = OPTIONS[state];
  for (const name of ["execution", "by", "reason"] as const) {
    if (values[name] !== undefined && options[name] === undefined) return { ok: false, message: `${state} takes no --${name}` };
    if (values[name] === undefined && options[name] === "required") return { ok: false, message: `${state} needs --${name}` };
  }
  const { execution, by, reason } = values;
  if (execution !== undefined && !EXECUTION_ARN.test(execution)) return { ok: false, message: "--execution must be a Step Functions execution ARN" };
  if (by !== undefined && !LOGIN.test(by)) return { ok: false, message: "--by must be a GitHub login" };
  if (reason !== undefined && !isEscalationReason(reason)) return { ok: false, message: `--reason must be one of ${ESCALATION_REASONS.join(", ")}` };

  return {
    ok: true,
    state,
    issueNumber,
    ...(execution === undefined ? {} : { executionArn: execution }),
    ...(by === undefined ? {} : { by }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function isWorkerState(value: string): value is WorkerState {
  return (WORKER_STATES as readonly string[]).includes(value);
}

function isEscalationReason(value: string): value is EscalationReason {
  return (ESCALATION_REASONS as readonly string[]).includes(value);
}

export const ENV = {
  /** AwaitApproval's task token, set by the state machine as an environment override. */
  taskToken: "FACTORY_TASK_TOKEN",
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
