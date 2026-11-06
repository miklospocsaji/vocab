/**
 * The worker: `factory-worker <state> --issue <n>` runs one state's handler for the issue's
 * work item and reports the outcome by exit code (`WORKER_EXIT`), which the state machine
 * routes on. Every dependency is passed in; `main.ts` wires in the real ones.
 *
 * - Migrations run first, as in the CLI (`migrate()` takes an advisory lock).
 * - `intake` needs no clone. `proposal` clones the repository afresh into the task's home
 *   and adds the work item's worktree there, unless the work item is past Proposal, in which
 *   case nothing is cloned and no role runs.
 * - The cloud states (add-cloud-proposal-run): `intake --execution` ends with exit 4 for an
 *   issue whose work item belongs to another execution. `await-approval` stores the task token
 *   and posts the summary; any error in it fails the paused task with SendTaskFailure, since
 *   Step Functions does not watch that task. `approve` resumes the execution, `approved` records
 *   it, and `escalate` marks the work item after an infrastructure failure.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError, type Forge } from "@vocab/factory-forge";
import { findWorkItemByIssue, migrate, type WorkItemRow } from "@vocab/factory-ledger";
import {
  approve,
  approved,
  awaitApproval,
  ensureWorktree,
  escalateWorkItem,
  intake,
  NotApplicable,
  proposal,
  WORKER_EXIT,
  type GitIdentity,
  type TaskTokens,
  type Transition,
} from "@vocab/factory-orchestrator";
import type { Role, RunRole } from "@vocab/factory-roles";
import type pg from "pg";
import { ENV, parseWorkerArgs, USAGE, type WorkerArgs, type WorkerState } from "./config.ts";

export { WORKER_EXIT } from "@vocab/factory-orchestrator";

/** What AwaitApproval reports with SendTaskFailure: fixed text, never an error's message. */
export const AWAIT_APPROVAL_FAILURE = { error: "factory.AwaitApprovalFailed", cause: "The await-approval worker task failed; see its log." } as const;

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
  /** Step Functions, for the states that resume or fail a paused task. */
  taskTokens?: TaskTokens;
  /** AwaitApproval's task token, from FACTORY_TASK_TOKEN. */
  taskToken?: string;
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
  const taskToken = args.state === "await-approval" ? deps.taskToken : undefined;
  if (args.state === "await-approval" && (taskToken === undefined || taskToken === "")) {
    deps.err(`factory-worker: await-approval needs the task token in ${ENV.taskToken}\n`);
    return WORKER_EXIT.invalid;
  }

  let code: number;
  try {
    await migrate(deps.db);
    code = await runState(args, deps);
  } catch (error) {
    if (error instanceof InvalidInput || error instanceof NotApplicable) {
      deps.err(`factory-worker: ${error.message}\n`);
      code = WORKER_EXIT.invalid;
    } else {
      deps.err(`factory-worker: ${args.state} for issue #${String(args.issueNumber)} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      code = WORKER_EXIT.error;
    }
  }
  // Nothing else ends the paused AwaitApproval task: Step Functions does not watch it.
  if (taskToken !== undefined && code !== WORKER_EXIT.ok) await failTask(taskToken, deps);
  return code;
}

async function failTask(taskToken: string, deps: WorkerDeps): Promise<void> {
  try {
    await requireTaskTokens(deps).fail(taskToken, AWAIT_APPROVAL_FAILURE.error, AWAIT_APPROVAL_FAILURE.cause);
  } catch (error) {
    deps.err(`factory-worker: SendTaskFailure failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function requireTaskTokens(deps: WorkerDeps): TaskTokens {
  if (deps.taskTokens === undefined) throw new Error("no Step Functions client configured");
  return deps.taskTokens;
}

async function runState(args: WorkerArgs, deps: WorkerDeps): Promise<number> {
  const { state, issueNumber } = args;
  const { db, forge } = deps;
  const issue = `issue #${String(issueNumber)}`;
  switch (state) {
    case "intake":
    case "proposal":
      return report(state, issueNumber, await runHandler(args, deps), deps);
    case "await-approval": {
      const workItem = await requireWorkItem(db, issueNumber);
      await awaitApproval({ db, forge, readProposal: (item) => readProposal(item, deps) }, workItem, deps.taskToken ?? "");
      deps.out(`factory-worker: await-approval for ${issue}: work item ${workItem.changeId} awaits the owner's approval\n`);
      return WORKER_EXIT.ok;
    }
    case "approve": {
      const outcome = await approve({ db, forge, taskTokens: requireTaskTokens(deps) }, issueNumber, args.by ?? "");
      switch (outcome.kind) {
        case "resumed":
          deps.out(`factory-worker: approve for ${issue}: work item ${outcome.workItem.changeId} resumed\n`);
          return WORKER_EXIT.ok;
        case "nothing-awaits":
          deps.out(`factory-worker: approve for ${issue}: nothing awaits approval\n`);
          return WORKER_EXIT.ok;
        case "resume-failed": {
          const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          deps.err(`factory-worker: approve for ${issue}: resuming work item ${outcome.workItem.changeId} failed: ${message}\n`);
          return WORKER_EXIT.error;
        }
      }
      break;
    }
    case "approved": {
      const workItem = await approved({ db, forge }, await requireWorkItem(db, issueNumber));
      deps.out(`factory-worker: approved for ${issue}: work item ${workItem.changeId} is ${workItem.state}\n`);
      return WORKER_EXIT.ok;
    }
    case "escalate": {
      if (args.reason === undefined) throw new InvalidInput("escalate needs --reason");
      const workItem = await escalateWorkItem({ db, forge }, issueNumber, args.reason);
      deps.out(`factory-worker: escalate for ${issue}: ${workItem === undefined ? "no work item" : `work item ${workItem.changeId} is ${workItem.state}`} (${args.reason})\n`);
      return WORKER_EXIT.ok;
    }
  }
}

async function requireWorkItem(db: pg.Pool, issueNumber: number): Promise<WorkItemRow> {
  const workItem = await findWorkItemByIssue(db, issueNumber);
  if (workItem === undefined) throw new InvalidInput(`issue #${String(issueNumber)} has no work item; run intake first`);
  return workItem;
}

/** The pushed `proposal.md`, from a fresh clone and the work item's worktree; undefined if it cannot be read. */
async function readProposal(workItem: WorkItemRow, deps: WorkerDeps): Promise<string | undefined> {
  try {
    const repo = await freshClone(deps);
    const worktree = await ensureWorktree({ repo, changeId: workItem.changeId, branch: workItem.branch, home: deps.home });
    return await readFile(join(worktree, "openspec/changes", workItem.changeId, "proposal.md"), "utf8");
  } catch (error) {
    deps.err(`factory-worker: reading proposal.md of ${workItem.changeId} failed, so the summary leaves it out: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

async function runHandler(args: WorkerArgs, deps: WorkerDeps): Promise<Transition> {
  const { state, issueNumber } = args;
  const { db, forge } = deps;
  switch (state) {
    case "intake":
      try {
        return await intake({ db, forge }, { issueNumber, ...(args.executionArn === undefined ? {} : { executionArn: args.executionArn }) });
      } catch (error) {
        if (error instanceof ForgeError && error.kind === "not-found") throw new InvalidInput(`issue #${String(issueNumber)} not found`);
        throw error;
      }
    default: {
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
    case "duplicate":
      deps.out(`factory-worker: ${state} for ${issue}: work item ${transition.workItem.changeId} belongs to another execution; this one ends\n`);
      return WORKER_EXIT.ended;
  }
}
