/**
 * The local run loop of M1: walks one issue's work item through its states with the state
 * handlers, until the requested stopping point. Re-runs resume the existing work item by
 * issue number; a work item at or past the stopping point, or escalated, runs nothing.
 * In M2, Step Functions takes over the sequencing and the handlers stay as they are.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProposalResult } from "@vocab/factory-artifacts";
import { findWorkItemByIssue, type WorkItemRow } from "@vocab/factory-ledger";
import { factoryHome, worktreePath } from "./git.ts";
import type { Transition, WorkItemState } from "./handler.ts";
import { intake } from "./intake.ts";
import { proposal, type ProposalContext } from "./proposal.ts";
import { renderProposalSummary } from "./summary.ts";

/** The states a run can stop after. M1 stops after Proposal only. */
export type RunUntil = "proposal";
export const RUN_UNTIL: readonly RunUntil[] = ["proposal"];

/** Where a run with each `--until` leaves the work item. */
const STOP_STATE: Record<RunUntil, WorkItemState> = { proposal: "awaiting-proposal-approval" };

/** The order of the states; `escalated` is outside it. `proposal-approved` is reached in the cloud only. */
const ORDER: readonly WorkItemState[] = ["intake", "proposal", "awaiting-proposal-approval", "proposal-approved"];

export interface RunRequest {
  issueNumber: number;
  until: RunUntil;
}

/**
 * - `stopped`: the work item is at (or past) the stopping point. `advanced` is false when it
 *   already was, so the run did nothing.
 * - `rejected`: Intake refused the issue; no work item exists.
 * - `escalated`: the work item waits for the owner. `advanced` is false when it already did.
 */
export type RunOutcome =
  | { kind: "stopped"; workItem: WorkItemRow; advanced: boolean }
  | { kind: "rejected"; reason: string }
  | { kind: "escalated"; workItem: WorkItemRow; reason: string; advanced: boolean };

export function isRunUntil(value: string): value is RunUntil {
  return (RUN_UNTIL as readonly string[]).includes(value);
}

export async function runWorkItem(ctx: ProposalContext, request: RunRequest): Promise<RunOutcome> {
  const stop = STOP_STATE[request.until];
  const existing = await findWorkItemByIssue(ctx.db, request.issueNumber);
  if (existing !== undefined) {
    const settled = settledOutcome(existing, stop);
    if (settled !== undefined) return settled;
  }

  let transition: Transition = await intake(ctx, { issueNumber: request.issueNumber });
  while (transition.kind === "advance") {
    const workItem = transition.workItem;
    const state = workItem.state as WorkItemState;
    if (state === stop) return { kind: "stopped", workItem, advanced: true };
    switch (state) {
      case "proposal":
        transition = await proposal(ctx, workItem);
        if (transition.kind === "advance") await postSummary(ctx, transition.workItem, transition.result);
        break;
      default:
        throw new Error(`work item ${workItem.changeId} is in state ${workItem.state}, which the M1 run loop cannot handle`);
    }
  }
  switch (transition.kind) {
    case "reject":
      return { kind: "rejected", reason: transition.reason };
    case "escalate":
      return { kind: "escalated", workItem: transition.workItem, reason: transition.reason, advanced: true };
    case "duplicate":
      // Only a cloud Intake, with an execution ARN, returns it; a local run never does.
      return { kind: "stopped", workItem: transition.workItem, advanced: false };
  }
}

/** The outcome for a work item that needs no handler at all, if it is one. */
function settledOutcome(workItem: WorkItemRow, stop: WorkItemState): RunOutcome | undefined {
  if (workItem.state === "escalated") {
    return { kind: "escalated", workItem, reason: "the work item is escalated and waits for the owner", advanced: false };
  }
  const at = ORDER.indexOf(workItem.state as WorkItemState);
  if (at !== -1 && at >= ORDER.indexOf(stop)) return { kind: "stopped", workItem, advanced: false };
  return undefined;
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
