/**
 * The factory CLI, with its dependencies passed in so tests can drive it:
 * - `run --issue <n> --until proposal|design|plan|pr`
 * - `approve --issue <n>`: the owner's approval of a local run, which has no `/approve` comment
 * - `cost --issue <n>`
 * `main.ts` wires in the real ledger, GitHub and Agent SDK.
 */
import { parseArgs } from "node:util";
import { findWorkItemByIssue, listAttempts, listAttemptUsage, type AttemptRow, type AttemptUsage, type Db, type WorkItemRow } from "@vocab/factory-ledger";
import { approveLocally, isRunUntil, RUN_UNTIL, runWorkItem, type RunContext } from "@vocab/factory-orchestrator";

/** Exit codes of the CLI. */
export const EXIT_CODES = {
  ok: 0,
  /** The work item was rejected or is escalated, `approve` found nothing awaiting, or `cost` found no work item. */
  failed: 1,
  /** The command line was invalid. */
  usage: 2,
  /** An unexpected error (set by `main.ts`). */
  error: 3,
} as const;

export interface CliEnv {
  db: Db;
  /** Receives everything the CLI prints to stdout. */
  out: (text: string) => void;
  /** Receives everything the CLI prints to stderr. */
  err: (text: string) => void;
  /** What `run` and `approve` need besides the ledger. Only they call it, so `cost` needs no GitHub token. */
  runContext: () => Promise<Omit<RunContext, "db">>;
}

export const USAGE = [
  "Usage:",
  `  pnpm factory run --issue <n> --until <${RUN_UNTIL.join("|")}>`,
  "  pnpm factory approve --issue <n>",
  "  pnpm factory cost --issue <n>",
  "",
].join("\n");

class UsageError extends Error {}

/** Runs one CLI command and resolves with its exit code. Unexpected errors reject. */
export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError) && !isParseArgsError(error)) throw error;
    env.err(`factory: ${error.message}\n\n${USAGE}`);
    return EXIT_CODES.usage;
  }
  switch (command.name) {
    case "run":
      return run(command, env);
    case "approve":
      return approve(command, env);
    case "cost":
      return cost(command, env);
  }
}

type Command = { name: "run"; issueNumber: number; until: (typeof RUN_UNTIL)[number] } | { name: "approve"; issueNumber: number } | { name: "cost"; issueNumber: number };

const COMMANDS = ["run", "approve", "cost"] as const;

function isCommand(name: string | undefined): name is (typeof COMMANDS)[number] {
  return (COMMANDS as readonly (string | undefined)[]).includes(name);
}

function parseCommand(argv: string[]): Command {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { issue: { type: "string" }, until: { type: "string" } },
  });
  const [name, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0] ?? ""}`);
  if (!isCommand(name)) throw new UsageError(name === undefined ? "no command given" : `unknown command ${name}`);

  const issueNumber = Number(values.issue);
  if (values.issue === undefined || !/^[1-9][0-9]*$/.test(values.issue) || !Number.isSafeInteger(issueNumber)) {
    throw new UsageError("--issue must be an issue number");
  }

  if (name !== "run") {
    if (values.until !== undefined) throw new UsageError(`${name} takes no --until`);
    return { name, issueNumber };
  }
  if (values.until === undefined || !isRunUntil(values.until)) {
    throw new UsageError(`--until must be one of: ${RUN_UNTIL.join(", ")}`);
  }
  return { name, issueNumber, until: values.until };
}

/** parseArgs rejects unknown options and missing values with a TypeError coded `ERR_PARSE_ARGS_*`. */
function isParseArgsError(error: unknown): error is Error {
  if (!(error instanceof TypeError)) return false;
  const code = (error as TypeError & { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

async function run(command: Extract<Command, { name: "run" }>, env: CliEnv): Promise<number> {
  const ctx = { ...(await env.runContext()), db: env.db };
  const outcome = await runWorkItem(ctx, { issueNumber: command.issueNumber, until: command.until });
  switch (outcome.kind) {
    case "stopped": {
      const lines = [
        outcome.advanced
          ? `${describe(outcome.workItem)} is now ${outcome.workItem.state}.`
          : `Nothing to do: ${describe(outcome.workItem)} is already ${outcome.workItem.state}. No agent ran.`,
      ];
      if (outcome.awaiting !== undefined) {
        lines.push(`The ${outcome.awaiting} awaits your approval. Review it, then run: pnpm factory approve --issue ${String(command.issueNumber)}`);
      }
      if (outcome.pullRequestUrl !== undefined) lines.push(`Pull request: ${outcome.pullRequestUrl}`);
      env.out(`${lines.join("\n")}\n`);
      return EXIT_CODES.ok;
    }
    case "rejected":
      env.err(`factory: issue #${String(command.issueNumber)} was rejected: ${outcome.reason}\n`);
      return EXIT_CODES.failed;
    case "escalated":
      env.err(
        outcome.advanced
          ? `factory: ${describe(outcome.workItem)} is escalated: ${outcome.reason}\n`
          : `factory: ${describe(outcome.workItem)} is escalated and waits for the owner. No agent ran.\n`,
      );
      return EXIT_CODES.failed;
  }
}

async function approve(command: Extract<Command, { name: "approve" }>, env: CliEnv): Promise<number> {
  const ctx = { ...(await env.runContext()), db: env.db };
  const outcome = await approveLocally(ctx, command.issueNumber);
  switch (outcome.kind) {
    case "approved":
      env.out(`Approved the ${outcome.approval} of ${describe(outcome.workItem)}. It is now ${outcome.workItem.state}; continue with: pnpm factory run --issue ${String(command.issueNumber)} --until pr\n`);
      return EXIT_CODES.ok;
    case "nothing-awaits":
      env.err(
        outcome.workItem === undefined
          ? `factory: nothing awaits approval: issue #${String(command.issueNumber)} has no work item\n`
          : `factory: nothing awaits approval: ${describe(outcome.workItem)} is ${outcome.workItem.state}\n`,
      );
      return EXIT_CODES.failed;
    case "escalated":
      env.err(`factory: ${describe(outcome.workItem)} is escalated: ${outcome.reason}\n`);
      return EXIT_CODES.failed;
  }
}

async function cost(command: Extract<Command, { name: "cost" }>, env: CliEnv): Promise<number> {
  const workItem = await findWorkItemByIssue(env.db, command.issueNumber);
  if (workItem === undefined) {
    env.err(`factory: issue #${String(command.issueNumber)} has no work item\n`);
    return EXIT_CODES.failed;
  }
  const attempts = await listAttempts(env.db, workItem.id);
  const usage = new Map((await listAttemptUsage(env.db, workItem.id)).map((row) => [row.attemptId, row]));

  const lines = [`${describe(workItem)}, state ${workItem.state}`];
  if (attempts.length === 0) lines.push("  no attempts yet");
  let totalTokens = 0;
  let totalCost = 0;
  for (const attempt of attempts) {
    const tokens = usage.get(attempt.id);
    totalTokens += tokens === undefined ? 0 : tokenTotal(tokens);
    totalCost += attempt.costUsdEstimate ?? 0;
    lines.push(attemptLine(attempt, tokens));
  }
  lines.push(`  total  ${formatTokens(totalTokens)}  ${formatUsd(totalCost)} (estimate)`);
  env.out(`${lines.join("\n")}\n`);
  return EXIT_CODES.ok;
}

function attemptLine(attempt: AttemptRow, usage: AttemptUsage | undefined): string {
  const outcome =
    attempt.outcome === null ? "open" : attempt.outcome === "failed" ? `failed (${attempt.failureReason ?? "unknown"})` : attempt.outcome;
  const tokens =
    usage === undefined
      ? formatTokens(0)
      : `${formatTokens(tokenTotal(usage))} (in ${count(usage.inputTokens)}, out ${count(usage.outputTokens)}, cache read ${count(usage.cacheReadTokens)}, cache write ${count(usage.cacheCreationTokens)})`;
  return [
    `  #${String(attempt.n)}`,
    attempt.state,
    attempt.role,
    outcome,
    attempt.authMode ?? "unknown auth mode",
    tokens,
    attempt.costUsdEstimate === null ? "no estimate" : formatUsd(attempt.costUsdEstimate),
  ].join("  ");
}

function describe(workItem: WorkItemRow): string {
  return `Work item ${workItem.changeId} (issue #${String(workItem.issueNumber)})`;
}

function tokenTotal(usage: AttemptUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

const COUNT = new Intl.NumberFormat("en-US");
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

function count(n: number): string {
  return COUNT.format(n);
}

function formatTokens(n: number): string {
  return `${count(n)} tokens`;
}

function formatUsd(n: number): string {
  return USD.format(n);
}
