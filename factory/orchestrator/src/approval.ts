/**
 * The owner's approval of a proposal in the cloud, and escalation of a crashed worker
 * (add-cloud-proposal-run design, "Worker states"):
 * - AwaitApproval stores the task token, then posts the summary, so the owner cannot reply to a
 *   summary before its token exists.
 * - `/approve` closes the open approval and resumes the execution with its token. If resuming
 *   fails, the approval is reopened, so the owner can try again.
 * - Approved records the outcome; Escalate marks the work item and says why, by a fixed code.
 * Like the other handlers, these are plain async functions with no AWS-specific control flow:
 * Step Functions is behind `TaskTokens`.
 */
import { ProposalResult } from "@vocab/factory-artifacts";
import {
  closeApproval,
  findWorkItemByIssue,
  listAttempts,
  listAttemptUsage,
  openApproval,
  reopenApproval,
  setWorkItemState,
  type AuthMode,
  type WorkItemRow,
} from "@vocab/factory-ledger";
import type { EscalationReason } from "./exit-codes.ts";
import type { HandlerContext, WorkItemState } from "./handler.ts";
import { renderProposalSummary, type ProposalCost } from "./summary.ts";

/** Resumes or fails a paused Step Functions task: SendTaskSuccess and SendTaskFailure. */
export interface TaskTokens {
  succeed(taskToken: string, output: string): Promise<void>;
  fail(taskToken: string, error: string, cause: string): Promise<void>;
}

const PROPOSAL: WorkItemState = "proposal";
const AWAITING: WorkItemState = "awaiting-proposal-approval";
const APPROVED: WorkItemState = "proposal-approved";
const ESCALATED: WorkItemState = "escalated";

/** A state's input that does not fit the work item; the worker exits 2. */
export class NotApplicable extends Error {
  override readonly name = "NotApplicable";
}

export interface AwaitApprovalContext extends HandlerContext {
  /** The change's `proposal.md` from the pushed branch, if it can be read. */
  readProposal?: (workItem: WorkItemRow) => Promise<string | undefined>;
}

/**
 * Stores an open approval with the task token, then posts the summary with the proposal's cost
 * and the approval instruction. The work item stays `awaiting-proposal-approval`.
 */
export async function awaitApproval(ctx: AwaitApprovalContext, workItem: WorkItemRow, taskToken: string): Promise<WorkItemRow> {
  if (workItem.state !== AWAITING) {
    throw new NotApplicable(`work item ${workItem.changeId} is ${workItem.state}, not ${AWAITING}`);
  }
  const result = await proposalResult(ctx, workItem);
  const cost = await proposalCost(ctx, workItem);
  const proposal = await ctx.readProposal?.(workItem);

  await openApproval(ctx.db, { workItemId: workItem.id, taskToken });
  const body = renderProposalSummary({
    changeId: workItem.changeId,
    branch: workItem.branch,
    result,
    ...(proposal === undefined ? {} : { proposal }),
    cost,
    askForApproval: true,
  });
  await ctx.forge.comment(workItem.issueNumber, body);
  return workItem;
}

/**
 * - `resumed`: the approval is closed by `by`, and the execution resumed.
 * - `nothing-awaits`: there was no open approval; the issue got a comment saying so.
 * - `resume-failed`: resuming failed; the approval is open again and the issue says so.
 */
export type ApproveOutcome =
  | { kind: "resumed"; workItem: WorkItemRow }
  | { kind: "nothing-awaits"; workItem: WorkItemRow | undefined }
  | { kind: "resume-failed"; workItem: WorkItemRow; error: unknown };

export interface ApproveContext extends HandlerContext {
  taskTokens: TaskTokens;
}

/** The output the AwaitApproval task gets; the state machine drops it. */
const APPROVAL_OUTPUT = "{}";

/** The owner's `/approve`: `by` is the login the webhook verified as the owner's. */
export async function approve(ctx: ApproveContext, issueNumber: number, by: string): Promise<ApproveOutcome> {
  const workItem = await findWorkItemByIssue(ctx.db, issueNumber);
  // A work item no longer awaiting (escalated, say) may still hold an approval whose token is dead.
  const approval = workItem?.state === AWAITING ? await closeApproval(ctx.db, workItem.id, by) : undefined;
  if (workItem === undefined || approval === undefined) {
    await ctx.forge.comment(issueNumber, nothingAwaitsComment(workItem));
    return { kind: "nothing-awaits", workItem };
  }

  try {
    await ctx.taskTokens.succeed(approval.taskToken, APPROVAL_OUTPUT);
  } catch (error) {
    await reopenApproval(ctx.db, approval.id);
    await ctx.forge.comment(
      issueNumber,
      `The factory could not resume \`${workItem.changeId}\` after your approval, so the proposal still awaits it. Reply \`/approve\` again to retry.`,
    );
    return { kind: "resume-failed", workItem, error };
  }
  return { kind: "resumed", workItem };
}

function nothingAwaitsComment(workItem: WorkItemRow | undefined): string {
  if (workItem === undefined) return "Nothing awaits approval on this issue: it has no factory work item.";
  return `Nothing awaits approval: the work item \`${workItem.changeId}\` is \`${workItem.state}\`.`;
}

/**
 * Approved: confirms the approval on the issue and moves the work item to `proposal-approved`.
 * A work item there already is left as it is. The comment comes first, so a crash in between
 * repeats the comment rather than losing it.
 */
export async function approved(ctx: HandlerContext, workItem: WorkItemRow): Promise<WorkItemRow> {
  if (workItem.state === APPROVED) return workItem;
  if (workItem.state !== AWAITING) throw new NotApplicable(`work item ${workItem.changeId} is ${workItem.state}, not ${AWAITING}`);
  await ctx.forge.comment(
    workItem.issueNumber,
    `The proposal \`${workItem.changeId}\` is approved. The work item is now \`${APPROVED}\`; the states after it arrive in M3.`,
  );
  return setWorkItemState(ctx.db, workItem.id, APPROVED);
}

const ESCALATION_SUMMARY: Record<EscalationReason, string> = {
  "worker-failed": "a worker task failed or could not start, and its retries are used up",
  "worker-refused": "a worker task refused its input",
};

/**
 * Escalate: the state machine's answer to an infrastructure failure. Marks the work item
 * `escalated`, if there is one, and comments with the fixed reason code. A work item escalated
 * already is left as it is, with no second comment.
 */
export async function escalateWorkItem(ctx: HandlerContext, issueNumber: number, reason: EscalationReason): Promise<WorkItemRow | undefined> {
  const workItem = await findWorkItemByIssue(ctx.db, issueNumber);
  if (workItem?.state === ESCALATED) return workItem;
  const subject = workItem === undefined ? "this issue" : `\`${workItem.changeId}\``;
  await ctx.forge.comment(
    issueNumber,
    `The factory escalated ${subject} to the owner after an infrastructure failure (\`${reason}\`): ${ESCALATION_SUMMARY[reason]}. The Step Functions execution has the details.`,
  );
  return workItem === undefined ? undefined : setWorkItemState(ctx.db, workItem.id, ESCALATED);
}

/** The result of the work item's succeeded proposal attempt, stored in the ledger. */
async function proposalResult(ctx: HandlerContext, workItem: WorkItemRow): Promise<ProposalResult> {
  const succeeded = (await listAttempts(ctx.db, workItem.id)).filter((attempt) => attempt.state === PROPOSAL && attempt.outcome === "succeeded");
  const last = succeeded.at(-1);
  if (last === undefined) throw new Error(`work item ${workItem.changeId} has no succeeded proposal attempt`);
  return ProposalResult.parse(last.result);
}

/** Tokens, estimated cost and auth modes over all the work item's proposal attempts. */
export async function proposalCost(ctx: HandlerContext, workItem: WorkItemRow): Promise<ProposalCost> {
  const attempts = (await listAttempts(ctx.db, workItem.id)).filter((attempt) => attempt.state === PROPOSAL);
  const ids = new Set(attempts.map((attempt) => attempt.id));
  const usage = (await listAttemptUsage(ctx.db, workItem.id)).filter((row) => ids.has(row.attemptId));
  const sum = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens") => usage.reduce((total, row) => total + row[key], 0);
  const authModes = [...new Set(attempts.flatMap((attempt) => (attempt.authMode === null ? [] : [attempt.authMode])))] as AuthMode[];
  return {
    tokens: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), cacheCreationTokens: sum("cacheCreationTokens") },
    usd: attempts.reduce((total, attempt) => total + (attempt.costUsdEstimate ?? 0), 0),
    authModes,
  };
}
