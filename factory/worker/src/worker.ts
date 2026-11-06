/**
 * The worker: `factory-worker <state> --issue <n>` runs one state's handler for the issue's
 * work item and reports the outcome by exit code (`WORKER_EXIT`), which the state machine
 * routes on. Every dependency is passed in; `main.ts` wires in the real ones.
 *
 * - Migrations run first, as in the CLI (`migrate()` takes an advisory lock).
 * - `intake` needs no clone. `proposal` clones the repository afresh into the task's home
 *   and adds the work item's worktree there, unless the work item is past Proposal, in which
 *   case nothing is cloned and no role runs.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError, type Forge } from "@vocab/factory-forge";
import { findWorkItemByIssue, migrate } from "@vocab/factory-ledger";
import { intake, proposal, type GitIdentity, type Transition } from "@vocab/factory-orchestrator";
import type { Role, RunRole } from "@vocab/factory-roles";
import type pg from "pg";
import { parseWorkerArgs, USAGE, type WorkerState } from "./config.ts";

export const WORKER_EXIT = {
  /** The state advanced, or there was nothing to do. */
  ok: 0,
  /** Any other error; the state machine retries it. */
  error: 1,
  /** Invalid input; no role ran. */
  invalid: 2,
  /** The work item escalated. */
  escalated: 3,
  /** The run ends with no work item to continue (a rejected issue). */
  ended: 4,
} as const;

export type WorkerIdentity = GitIdentity;

export interface WorkerDeps {
  /** A pool, since migrations take a client of their own. */
  db: pg.Pool;
  forge: Forge;
  runRole: RunRole;
  /** The proposal-author role, from the image. */
  role: Role;
  /** The task's temp home: the clone and the worktrees live here. */
  home: string;
  /** The author and committer of the factory's commits: the App's bot user. */
  committer?: WorkerIdentity;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Input the worker refuses with exit 2. */
class InvalidInput extends Error {}

export async function runWorker(argv: string[], deps: WorkerDeps): Promise<number> {
  const args = parseWorkerArgs(argv);
  if (!args.ok) {
    deps.err(`factory-worker: ${args.message}\n\n${USAGE}`);
    return WORKER_EXIT.invalid;
  }
  try {
    await migrate(deps.db);
    const transition = await runState(args.state, args.issueNumber, deps);
    return report(args.state, args.issueNumber, transition, deps);
  } catch (error) {
    if (error instanceof InvalidInput) {
      deps.err(`factory-worker: ${error.message}\n`);
      return WORKER_EXIT.invalid;
    }
    deps.err(`factory-worker: ${args.state} for issue #${String(args.issueNumber)} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return WORKER_EXIT.error;
  }
}

async function runState(state: WorkerState, issueNumber: number, deps: WorkerDeps): Promise<Transition> {
  const { db, forge } = deps;
  switch (state) {
    case "intake":
      try {
        return await intake({ db, forge }, { issueNumber });
      } catch (error) {
        if (error instanceof ForgeError && error.kind === "not-found") throw new InvalidInput(`issue #${String(issueNumber)} not found`);
        throw error;
      }
    case "proposal": {
      const workItem = await findWorkItemByIssue(db, issueNumber);
      if (workItem === undefined) throw new InvalidInput(`issue #${String(issueNumber)} has no work item; run intake first`);
      // Past Proposal (or escalated): the handler returns at once, so clone nothing.
      if (workItem.state !== "proposal") return proposal({ db, forge, runRole: deps.runRole, role: deps.role, repo: deps.home }, workItem);

      const repo = await freshClone(deps);
      return proposal(
        {
          db,
          forge,
          runRole: deps.runRole,
          role: deps.role,
          repo,
          home: deps.home,
          ...(deps.committer === undefined ? {} : { committer: deps.committer }),
        },
        workItem,
      );
    }
  }
}

/** `<home>/repo`, cloned from the forge; any clone or worktrees from before are removed first. */
async function freshClone(deps: WorkerDeps): Promise<string> {
  const repo = join(deps.home, "repo");
  await rm(repo, { recursive: true, force: true });
  await rm(join(deps.home, "worktrees"), { recursive: true, force: true });
  await mkdir(deps.home, { recursive: true });
  await deps.forge.clone(repo);
  return repo;
}

function report(state: WorkerState, issueNumber: number, transition: Transition, deps: WorkerDeps): number {
  const issue = `issue #${String(issueNumber)}`;
  switch (transition.kind) {
    case "advance":
      deps.out(`factory-worker: ${state} for ${issue}: work item ${transition.workItem.changeId} is ${transition.workItem.state}\n`);
      return WORKER_EXIT.ok;
    case "reject":
      deps.err(`factory-worker: ${state} for ${issue}: rejected: ${transition.reason}\n`);
      return WORKER_EXIT.ended;
    case "escalate":
      deps.err(`factory-worker: ${state} for ${issue}: work item ${transition.workItem.changeId} escalated: ${transition.reason}\n`);
      return WORKER_EXIT.escalated;
  }
}
