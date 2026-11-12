/**
 * The local run loop: walks one issue's work item through its states with the same handlers as
 * the worker, until the requested stopping point. Re-runs resume the existing work item by issue
 * number; a work item at or past the stopping point, or escalated, runs nothing.
 *
 * The stopping points are phases: `proposal` (up to the proposal approval), `design` (up to an
 * accepted design), `plan` (up to the stored plan) and `pr` (the build loop and the pull request).
 * A run stops before the first handler of a later phase, and always at an open approval, which
 * `pnpm factory approve` closes locally: local runs have no task token. The build loop runs
 * `step` per task in plan order, with the build runner in between, and goes back to Design on a
 * design flaw. In the cloud, Step Functions does the sequencing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProposalResult } from "@vocab/factory-artifacts";
import { closeApproval, findOpenApproval, findWorkItemByIssue, listTasks, setWorkItemState, type WorkItemRow } from "@vocab/factory-ledger";
import type { PlanPaths, Role } from "@vocab/factory-roles";
import { approved } from "./approval.ts";
import type { ArtifactStore, RunBuild } from "./build-io.ts";
import { design } from "./design.ts";
import { changeFileReader, factoryHome, worktreePath } from "./git.ts";
import type { Transition, WorkItemState } from "./handler.ts";
import { intake } from "./intake.ts";
import { openPr } from "./open-pr.ts";
import { plan } from "./plan.ts";
import { proposal, type ProposalContext } from "./proposal.ts";
import { step } from "./step.ts";
import { renderProposalSummary } from "./summary.ts";

/** The phases a run can stop after, in order. */
export type RunUntil = "proposal" | "design" | "plan" | "pr";
export const RUN_UNTIL: readonly RunUntil[] = ["proposal", "design", "plan", "pr"];

/** How long a build waits after an infrastructure failure, as the state machine's WaitInfra. */
const INFRA_WAIT_MS = 60_000;

/** What a local run needs besides the proposal: every role after it, the store and the build runner. */
export interface RunContext extends ProposalContext {
  architect: Role;
  designReviewer: Role;
  planner: Role;
  planPaths: PlanPaths;
  testAuthor: Role;
  implementer: Role;
  classifier: Role;
  store: ArtifactStore;
  runBuild: RunBuild;
  /** What the build container clones, with no token. */
  cloneUrl: string;
  /** Waits before a build that follows an infrastructure failure; defaults to 60 seconds. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * - `approved`: the open approval of that kind is closed, and the work item advanced.
 * - `nothing-awaits`: the work item, if there is one, awaits no approval.
 * - `escalated`: approving routed the work item to the owner (an unknown complexity).
 */
export type LocalApproveOutcome =
  | { kind: "approved"; approval: "proposal" | "design"; workItem: WorkItemRow }
  | { kind: "nothing-awaits"; workItem: WorkItemRow | undefined }
  | { kind: "escalated"; workItem: WorkItemRow; reason: string };

/**
 * `pnpm factory approve --issue <n>`: the owner's approval of a local run. The proposal is
 * approved through the `approved` handler, which comments and routes; a `large` change's design
 * goes to Plan with a comment. An approval row, if one is open, is closed.
 */
export async function approveLocally(ctx: Omit<RunContext, "runBuild" | "store">, issueNumber: number): Promise<LocalApproveOutcome> {
  const workItem = await findWorkItemByIssue(ctx.db, issueNumber);
  if (workItem?.state === "awaiting-proposal-approval") {
    if ((await findOpenApproval(ctx.db, workItem.id)) !== undefined) await closeApproval(ctx.db, workItem.id, "local");
    const transition = await approved({ ...ctx, readChangeFile: readChangeFile(ctx) }, workItem);
    if (transition.kind === "escalate") return { kind: "escalated", workItem: transition.workItem, reason: transition.reason };
    if (transition.kind !== "advance") throw new Error(`approving ${workItem.changeId} ended with ${transition.kind}`);
    return { kind: "approved", approval: "proposal", workItem: transition.workItem };
  }
  if (workItem?.state === "awaiting-design-approval") {
    if ((await findOpenApproval(ctx.db, workItem.id)) !== undefined) await closeApproval(ctx.db, workItem.id, "local");
    await ctx.forge.comment(workItem.issueNumber, `The design of \`${workItem.changeId}\` is approved. The work item is now \`plan\`.`);
    return { kind: "approved", approval: "design", workItem: await setWorkItemState(ctx.db, workItem.id, "plan") };
  }
  return { kind: "nothing-awaits", workItem };
}

function readChangeFile(ctx: Pick<RunContext, "repo" | "home">) {
  return changeFileReader({ repo: ctx.repo, ...(ctx.home === undefined ? {} : { home: ctx.home }) });
}

export interface RunRequest {
  issueNumber: number;
  until: RunUntil;
}

/**
 * - `stopped`: the work item is at (or past) the stopping point, or at an open approval
 *   (`awaiting`). `advanced` is false when it already was, so the run did nothing. A work item
 *   that reached `pr-open` has its pull request's URL.
 * - `rejected`: Intake refused the issue; no work item exists.
 * - `escalated`: the work item waits for the owner. `advanced` is false when it already did.
 */
export type RunOutcome =
  | { kind: "stopped"; workItem: WorkItemRow; advanced: boolean; awaiting?: "proposal" | "design"; pullRequestUrl?: string }
  | { kind: "rejected"; reason: string }
  | { kind: "escalated"; workItem: WorkItemRow; reason: string; advanced: boolean };

export function isRunUntil(value: string): value is RunUntil {
  return (RUN_UNTIL as readonly string[]).includes(value);
}

/** The next handler for a work item, and the phase it belongs to. */
interface Next {
  phase: RunUntil;
  run: () => Promise<Transition>;
}

export async function runWorkItem(ctx: RunContext, request: RunRequest): Promise<RunOutcome> {
  const limit = RUN_UNTIL.indexOf(request.until);
  let advanced = false;
  let workItem = await findWorkItemByIssue(ctx.db, request.issueNumber);

  for (;;) {
    if (workItem !== undefined) {
      const settled = await settledOutcome(ctx, workItem, advanced);
      if (settled !== undefined) return settled;
    }
    const next: Next = workItem === undefined || workItem.state === "intake" ? { phase: "proposal", run: () => intake(ctx, { issueNumber: request.issueNumber }) } : await nextHandler(ctx, workItem);
    if (workItem !== undefined && RUN_UNTIL.indexOf(next.phase) > limit) return { kind: "stopped", workItem, advanced };

    const transition = await next.run();
    switch (transition.kind) {
      case "advance":
        workItem = transition.workItem;
        advanced = true;
        break;
      case "reject":
        return { kind: "rejected", reason: transition.reason };
      case "escalate":
        return { kind: "escalated", workItem: transition.workItem, reason: transition.reason, advanced: true };
      case "duplicate":
        // Only a cloud Intake, with an execution ARN, returns it; a local run never does.
        return { kind: "stopped", workItem: transition.workItem, advanced: false };
    }
  }
}

/** The outcome for a work item that no handler moves on: escalated, at an approval, or done. */
async function settledOutcome(ctx: RunContext, workItem: WorkItemRow, advanced: boolean): Promise<RunOutcome | undefined> {
  switch (workItem.state as WorkItemState) {
    case "escalated":
      return { kind: "escalated", workItem, reason: "the work item is escalated and waits for the owner", advanced };
    case "awaiting-proposal-approval":
      return { kind: "stopped", workItem, advanced, awaiting: "proposal" };
    case "awaiting-design-approval":
      return { kind: "stopped", workItem, advanced, awaiting: "design" };
    case "pr-open": {
      const pr = await ctx.forge.findPullRequest(workItem.branch);
      return { kind: "stopped", workItem, advanced, ...(pr === undefined ? {} : { pullRequestUrl: pr.url }) };
    }
    default:
      return undefined;
  }
}

async function nextHandler(ctx: RunContext, workItem: WorkItemRow): Promise<Next> {
  switch (workItem.state as WorkItemState) {
    case "proposal":
      return {
        phase: "proposal",
        run: async () => {
          const transition = await proposal(ctx, workItem);
          if (transition.kind === "advance") await postSummary(ctx, transition.workItem, transition.result);
          return transition;
        },
      };
    case "proposal-approved": {
      // Approved again, with no comment: it only routes on the change's complexity, or escalates.
      const routed = await approved({ ...ctx, readChangeFile: readChangeFile(ctx) }, workItem);
      if (routed.kind !== "advance") return { phase: "proposal", run: () => Promise.resolve(routed) };
      return routed.route === "plan" ? { phase: "plan", run: () => plan(ctx, workItem) } : { phase: "design", run: () => design(ctx, workItem) };
    }
    case "design":
    case "design-review":
      return { phase: "design", run: () => design(ctx, workItem) };
    case "plan":
      return { phase: "plan", run: () => plan(ctx, workItem) };
    case "build":
      return { phase: "pr", run: () => buildLoop(ctx, workItem) };
    default:
      throw new Error(`work item ${workItem.changeId} is in state ${workItem.state}, which the run loop cannot handle`);
  }
}

/**
 * Builds the unfinished tasks in plan order, `step` and the build runner in turn, then opens the
 * pull request. A design flaw advances the work item to Design, where the run loop goes on.
 */
async function buildLoop(ctx: RunContext, item: WorkItemRow): Promise<Transition> {
  const wait = ctx.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let workItem = item;
  for (const task of (await listTasks(ctx.db, item.id)).filter((row) => row.status === "pending")) {
    for (;;) {
      const result = await step(ctx, workItem, task.taskId);
      workItem = result.workItem;
      if (result.kind === "done") break;
      if (result.kind === "design-flaw") return { kind: "advance", workItem };
      if (result.kind === "escalate") return { kind: "escalate", workItem, reason: result.reason };
      if (result.afterWait) await wait(INFRA_WAIT_MS);
      await ctx.runBuild({ changeId: workItem.changeId, taskId: task.taskId });
    }
  }
  return openPr(ctx, workItem);
}

async function postSummary(ctx: ProposalContext, workItem: WorkItemRow, result: unknown): Promise<void> {
  const worktree = worktreePath(workItem.changeId, ctx.home ?? factoryHome());
  const proposalMd = await readFile(join(worktree, "openspec/changes", workItem.changeId, "proposal.md"), "utf8").catch(() => undefined);
  const body = renderProposalSummary({
    changeId: workItem.changeId,
    branch: workItem.branch,
    result: ProposalResult.parse(result),
    ...(proposalMd === undefined ? {} : { proposal: proposalMd }),
  });
  await ctx.forge.comment(workItem.issueNumber, body);
}
