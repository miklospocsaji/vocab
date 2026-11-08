import {
  createWorkItem,
  findWorkItemByChangeId,
  findWorkItemByIssue,
  IssueHasWorkItem,
  setWorkItemState,
  type WorkItemRow,
} from "@vocab/factory-ledger";
import { deriveChangeId } from "./change-id.ts";
import type { HandlerContext, Transition, WorkItemState } from "./handler.ts";

/** The input of the Intake state: only the issue, since no work item exists yet. */
export interface IntakeItem {
  issueNumber: number;
  /** The Step Functions execution running this Intake; absent in a local run. */
  executionArn?: string;
}

/** Posted on an issue that states no requirement. */
export const MISSING_REQUIREMENT_COMMENT =
  "The factory cannot start on this issue: its description is empty. Please state the requirement (what should change and why) in the issue body, then run the factory again.";

const INTAKE: WorkItemState = "intake";
const NEXT: WorkItemState = "proposal";

/**
 * Intake: checks that the issue states a requirement, derives the change id, creates the
 * work item in the ledger and the branch on the remote, and moves the work item to Proposal.
 *
 * Idempotent: the ledger row is written first, in state `intake`, and the branch second.
 * A re-run after a crash between the two finds the row and only creates the branch, so it
 * never leaves an orphan branch or derives a second change id.
 *
 * In the cloud, the work item belongs to the execution that created it. Intake for another
 * execution (the issue relabelled, or a delivery repeated) returns `duplicate` and changes
 * nothing; so does one whose insert loses to a concurrent Intake on the unique issue number.
 */
export async function intake(ctx: HandlerContext, item: IntakeItem): Promise<Transition> {
  const { db, forge } = ctx;

  const existing = await findWorkItemByIssue(db, item.issueNumber);
  if (existing !== undefined) return isOtherExecution(existing, item) ? { kind: "duplicate", workItem: existing } : finish(ctx, existing);

  const issue = await forge.getIssue(item.issueNumber);
  if (issue.body.trim() === "") {
    await forge.comment(issue.number, MISSING_REQUIREMENT_COMMENT);
    return { kind: "reject", reason: `issue #${String(issue.number)} states no requirement: its body is empty` };
  }

  const changeId = await deriveChangeId(
    issue.title,
    async (id) => (await findWorkItemByChangeId(db, id)) !== undefined || (await forge.branchExists(id)),
  );
  let created: WorkItemRow;
  try {
    created = await createWorkItem(db, {
      issueNumber: issue.number,
      changeId,
      branch: changeId,
      state: INTAKE,
      ...(item.executionArn === undefined ? {} : { executionArn: item.executionArn }),
    });
  } catch (error) {
    if (!(error instanceof IssueHasWorkItem)) throw error;
    const winner = await findWorkItemByIssue(db, item.issueNumber);
    if (winner === undefined) throw error;
    return isOtherExecution(winner, item) ? { kind: "duplicate", workItem: winner } : finish(ctx, winner);
  }
  return finish(ctx, created);
}

/** A cloud Intake whose execution did not create the work item. A local run owns any work item. */
function isOtherExecution(workItem: WorkItemRow, item: IntakeItem): boolean {
  return item.executionArn !== undefined && workItem.executionArn !== item.executionArn;
}

/** Creates the branch (a no-op if it exists) and advances a work item still in Intake. */
async function finish(ctx: HandlerContext, workItem: WorkItemRow): Promise<Transition> {
  if (workItem.state !== INTAKE) return { kind: "advance", workItem };
  await ctx.forge.createBranch(workItem.branch);
  return { kind: "advance", workItem: await setWorkItemState(ctx.db, workItem.id, NEXT) };
}
