/**
 * Design (add-build-loop design, "Worker states"): the architect writes `design.md` and any
 * contracts under `app/contracts/src/`. Its output is accepted once the change passes
 * `openspec validate --strict` and the result its schema (the runner checks both), and each
 * accepted design is committed and pushed. Then:
 * - `medium`: a design reviewer runs in a session of its own. `approve` sends the work item to
 *   Plan; `changes-requested` sends the findings to the architect's next attempt.
 * - `large`: the work item waits for the owner's design approval.
 * Design escalates after MAX_DESIGN_ATTEMPTS architect attempts in total, or at once on an
 * `auth-mode-mismatch`. A `small` change comes here only when the build loop found a design flaw,
 * and then takes the `medium` route.
 *
 * Back from the build loop for a design flaw, the architect's first attempt has the flaw's
 * evidence in its prompt, and attempts are counted from the flaw.
 *
 * Its state is re-derived from the ledger, so a retried task goes on where the last one ended:
 * `design` runs the architect, `design-review` the reviewer on the pushed design.
 */
import { join } from "node:path";
import { ReviewResult } from "@vocab/factory-artifacts";
import { closeAttempt, listAttempts, openAttempt, setWorkItemState, type AttemptRow, type WorkItemRow } from "@vocab/factory-ledger";
import { AttemptFailed, type RetryEvidence, type Role, type RunRole, type WorkItem } from "@vocab/factory-roles";
import { NotApplicable } from "./approval.ts";
import { changeFiles, changeFolder, currentSpecs, readComplexity, readIfExists } from "./change-files.ts";
import { pendingDesignFlaw } from "./design-flaw.ts";
import { escalateWith } from "./escalation.ts";
import { renderEvidence, renderFindings } from "./evidence.ts";
import { commitPaths, ensureWorktree, type GitIdentity } from "./git.ts";
import type { HandlerContext, Route, Transition, WorkItemState } from "./handler.ts";

/** Architect attempts per Design, in total, before the work item escalates. */
export const MAX_DESIGN_ATTEMPTS = 3;
/** Reviewer attempts that fail to return a review, in total, before the work item escalates. */
const MAX_REVIEW_FAILURES = 3;

const DESIGN: WorkItemState = "design";
const REVIEW: WorkItemState = "design-review";
const AWAITING_DESIGN: WorkItemState = "awaiting-design-approval";
const PLAN: WorkItemState = "plan";
/** States Design has finished with; a repeated Design does nothing for them. */
const PAST: readonly string[] = [AWAITING_DESIGN, PLAN, "build", "pr-open", "escalated"];

/** Where the architect may write, as the role's config says; the design commit takes only these. */
const CONTRACTS = "app/contracts/src";

export interface DesignContext extends HandlerContext {
  runRole: RunRole;
  architect: Role;
  designReviewer: Role;
  /** The local clone the work item's worktree is added to. */
  repo: string;
  /** The factory's home directory; defaults to `factoryHome()`. */
  home?: string;
  /** The author and committer of the design commit; defaults to `FACTORY_GIT_IDENTITY`. */
  committer?: GitIdentity;
}

export async function design(ctx: DesignContext, item: WorkItemRow): Promise<Transition> {
  if (PAST.includes(item.state)) {
    const route: Route | undefined = item.state === AWAITING_DESIGN ? "owner-review" : item.state === "escalated" ? undefined : "plan";
    return { kind: "advance", workItem: item, ...(route === undefined ? {} : { route }) };
  }
  if (item.state !== "proposal-approved" && item.state !== DESIGN && item.state !== REVIEW) {
    throw new NotApplicable(`work item ${item.changeId} is ${item.state}, not ready for Design`);
  }
  const { db } = ctx;

  const worktree = await ensureWorktree({ repo: ctx.repo, changeId: item.changeId, branch: item.branch, ...(ctx.home === undefined ? {} : { home: ctx.home }) });
  const reading = readComplexity(await readIfExists(join(worktree, changeFolder(item.changeId), ".openspec.yaml")));
  if (!reading.ok) {
    return escalateWith(ctx, item, `The factory escalated \`${item.changeId}\` to the owner: ${reading.problem}.`, `unknown x-complexity: ${reading.problem}`);
  }
  const flaw = await pendingDesignFlaw(db, item.id);
  if (reading.complexity === "small" && flaw === undefined) throw new NotApplicable(`work item ${item.changeId} is a small change, which skips Design`);
  const complexity = reading.complexity === "small" ? "medium" : reading.complexity;
  const issue = await ctx.forge.getIssue(item.issueNumber);

  // A crash can leave an attempt open; it counts as failed, and toward the limit.
  const since = flaw === undefined ? 0n : BigInt(flaw.attempt.id);
  const previous = (await listAttempts(db, item.id)).filter((attempt) => (attempt.state === DESIGN || attempt.state === REVIEW) && BigInt(attempt.id) > since);
  for (const attempt of previous.filter(isOpen)) await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "error" });

  let workItem = item.state === "proposal-approved" ? await setWorkItemState(db, item.id, DESIGN) : item;
  let architectAttempts = previous.filter((attempt) => attempt.state === DESIGN).length;
  let reviewFailures = 0;
  let evidence: RetryEvidence | undefined = flaw !== undefined && architectAttempts === 0 ? flaw.evidence : undefined;
  let needsDesign = workItem.state === DESIGN;

  const roleInput = async (): Promise<WorkItem> => ({
    id: item.id,
    changeId: item.changeId,
    worktree,
    issue: { title: issue.title, body: issue.body },
    changeFiles: await changeFiles(worktree, item.changeId),
    specs: await currentSpecs(worktree),
  });

  for (;;) {
    if (needsDesign) {
      if (architectAttempts >= MAX_DESIGN_ATTEMPTS) return escalate(ctx, workItem, architectAttempts, evidence);
      architectAttempts += 1;
      const attempt = await openAttempt(db, { workItemId: item.id, state: DESIGN, role: ctx.architect.name });
      const outcome = await runAttempt(ctx, attempt, ctx.architect, await roleInput(), evidence);
      if (!outcome.ok) {
        evidence = { reason: outcome.failure.reason, evidence: outcome.failure.evidence };
        if (outcome.failure.reason === "auth-mode-mismatch") return escalate(ctx, workItem, architectAttempts, evidence);
        continue;
      }
      await commitPaths({
        worktree,
        paths: [`${changeFolder(item.changeId)}/design.md`, CONTRACTS],
        ...(ctx.committer === undefined ? {} : { identity: ctx.committer }),
        message: `docs(${item.changeId}): design the change\n\nWritten by the ${ctx.architect.name} role for issue #${String(item.issueNumber)}.`,
      });
      await ctx.forge.pushBranch({ worktree, branch: item.branch });
      if (complexity === "large") {
        return { kind: "advance", workItem: await setWorkItemState(db, item.id, AWAITING_DESIGN), result: outcome.result, route: "owner-review" };
      }
      workItem = await setWorkItemState(db, item.id, REVIEW);
    }

    // The reviewer starts from the artifacts only, with no evidence: a fresh session every time.
    const attempt = await openAttempt(db, { workItemId: item.id, state: REVIEW, role: ctx.designReviewer.name });
    const outcome = await runAttempt(ctx, attempt, ctx.designReviewer, await roleInput(), undefined);
    if (!outcome.ok) {
      reviewFailures += 1;
      if (outcome.failure.reason === "auth-mode-mismatch" || reviewFailures >= MAX_REVIEW_FAILURES) {
        return escalate(ctx, workItem, architectAttempts, { reason: outcome.failure.reason, evidence: outcome.failure.evidence }, "design review");
      }
      needsDesign = false;
      continue;
    }
    const review = ReviewResult.parse(outcome.result);
    if (review.verdict === "approve") {
      return { kind: "advance", workItem: await setWorkItemState(db, item.id, PLAN), result: outcome.result, route: "plan" };
    }
    evidence = { reason: "changes-requested", evidence: renderFindings(review.findings) };
    workItem = await setWorkItemState(db, item.id, DESIGN);
    needsDesign = true;
  }
}

type AttemptOutcome = { ok: true; result: unknown } | { ok: false; failure: AttemptFailed };

/** One attempt of a role, closed in the ledger with its result or failure reason. Errors other than AttemptFailed close it and reject. */
async function runAttempt(ctx: DesignContext, attempt: AttemptRow, role: Role, input: WorkItem, evidence: RetryEvidence | undefined): Promise<AttemptOutcome> {
  try {
    const result = await ctx.runRole(role, input, evidence);
    await closeAttempt(ctx.db, attempt.id, { outcome: "succeeded", result });
    return { ok: true, result };
  } catch (error) {
    if (!(error instanceof AttemptFailed)) {
      await closeAttempt(ctx.db, attempt.id, { outcome: "failed", failureReason: "error" });
      throw error;
    }
    await closeAttempt(ctx.db, attempt.id, { outcome: "failed", failureReason: error.reason });
    return { ok: false, failure: error };
  }
}

async function escalate(ctx: DesignContext, item: WorkItemRow, used: number, last: RetryEvidence | undefined, what = "design"): Promise<Transition> {
  const reason = last?.reason ?? "no attempts left";
  const summary =
    last?.reason === "auth-mode-mismatch"
      ? `The ${what} attempt failed with \`auth-mode-mismatch\`, which is never retried.`
      : last?.reason === "changes-requested"
        ? `The design reviewer requested changes to each of ${String(used)} designs.`
        : `The ${what} failed after ${String(used)} architect attempt(s)${last === undefined ? "" : `; the last one failed with \`${last.reason}\``}.`;
  const body = [
    `The factory escalated \`${item.changeId}\` to the owner. ${summary}`,
    ...(last === undefined ? [] : [last.reason === "changes-requested" ? "The last findings:" : "Evidence from the last attempt:", last.reason === "changes-requested" ? last.evidence : renderEvidence(last.evidence)]),
  ].join("\n\n");
  return escalateWith(ctx, item, body, `${what} escalated after ${String(used)} architect attempt(s): ${reason}`);
}

function isOpen(attempt: AttemptRow): boolean {
  return attempt.endedAt === null;
}
