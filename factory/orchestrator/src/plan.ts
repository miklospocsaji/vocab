/**
 * Plan (add-build-loop design, "Worker states"): the planner writes `tasks.md` and returns
 * `tasks.json`. Its output is accepted once the change passes strict validation (the runner
 * checks it) and `validatePlan` finds no problem. Failed attempts are retried with their
 * evidence, up to MAX_PLAN_ATTEMPTS in total, and then the work item escalates. An accepted
 * plan's tasks go to the ledger, `tasks.md` is committed and pushed, and the work item moves to
 * `build`. The transition carries the unfinished task ids, in order, for the build loop.
 *
 * Plan runs for a `small` change straight after Approved, for a `medium` one once the reviewer
 * approved its design, and for a `large` one once the owner closed its design approval. After a
 * design flaw it re-plans: attempts are counted from the flaw, and the ticked tasks stay done.
 */
import { join } from "node:path";
import { PlanResult } from "@vocab/factory-artifacts";
import { closeAttempt, findOpenApproval, listAttempts, listTasks, openAttempt, setWorkItemState, storePlan, type AttemptRow, type WorkItemRow } from "@vocab/factory-ledger";
import { AttemptFailed, validatePlan, type PlanPaths, type RetryEvidence, type Role, type RunRole, type WorkItem } from "@vocab/factory-roles";
import { NotApplicable } from "./approval.ts";
import { changeFiles, changeFolder, currentSpecs, readComplexity, readIfExists } from "./change-files.ts";
import { lastDesignFlawId } from "./design-flaw.ts";
import { escalateWith } from "./escalation.ts";
import { renderEvidence } from "./evidence.ts";
import { commitPaths, ensureWorktree, type GitIdentity } from "./git.ts";
import type { HandlerContext, Transition, WorkItemState } from "./handler.ts";

/** Planner attempts per Plan, in total, before the work item escalates. */
export const MAX_PLAN_ATTEMPTS = 3;

const PLAN: WorkItemState = "plan";
const BUILD: WorkItemState = "build";
/** States Plan has finished with; a repeated Plan does nothing for them. */
const PAST: readonly string[] = [BUILD, "pr-open"];

export interface PlanContext extends HandlerContext {
  runRole: RunRole;
  planner: Role;
  /** The implementer's and test author's globs, which every task's files and tests must fit. */
  planPaths: PlanPaths;
  /** The local clone the work item's worktree is added to. */
  repo: string;
  /** The factory's home directory; defaults to `factoryHome()`. */
  home?: string;
  /** The author and committer of the plan commit; defaults to `FACTORY_GIT_IDENTITY`. */
  committer?: GitIdentity;
}

export async function plan(ctx: PlanContext, item: WorkItemRow): Promise<Transition> {
  const { db } = ctx;
  if (PAST.includes(item.state)) return { kind: "advance", workItem: item, tasks: await unfinished(ctx, item) };

  const worktree = await ensureWorktree({ repo: ctx.repo, changeId: item.changeId, branch: item.branch, ...(ctx.home === undefined ? {} : { home: ctx.home }) });
  const folder = join(worktree, changeFolder(item.changeId));
  await requireReady(ctx, item, folder);
  const issue = await ctx.forge.getIssue(item.issueNumber);

  // A crash can leave an attempt open; it counts as failed, and toward the limit.
  const since = await lastDesignFlawId(db, item.id);
  const previousAttempts = (await listAttempts(db, item.id)).filter((attempt) => attempt.state === PLAN && BigInt(attempt.id) > since);
  for (const attempt of previousAttempts.filter(isOpen)) await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "error" });
  const workItem = item.state === PLAN ? item : await setWorkItemState(db, item.id, PLAN);

  // tasks.md as it was before any session, so a re-plan keeps its ticked lines.
  const previous = await readIfExists(join(folder, "tasks.md"));
  let used = previousAttempts.length;
  let evidence: RetryEvidence | undefined;
  while (used < MAX_PLAN_ATTEMPTS) {
    used += 1;
    const input: WorkItem = {
      id: item.id,
      changeId: item.changeId,
      worktree,
      issue: { title: issue.title, body: issue.body },
      changeFiles: await changeFiles(worktree, item.changeId),
      specs: await currentSpecs(worktree),
    };

    const attempt = await openAttempt(db, { workItemId: item.id, state: PLAN, role: ctx.planner.name });
    let result: unknown;
    try {
      result = await ctx.runRole(ctx.planner, input, evidence);
    } catch (error) {
      if (!(error instanceof AttemptFailed)) {
        await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "error" });
        throw error;
      }
      await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: error.reason });
      evidence = { reason: error.reason, evidence: error.evidence };
      if (error.reason === "auth-mode-mismatch") break;
      continue;
    }

    const problems = await checkPlan(ctx, result, folder, previous);
    if (problems.length > 0) {
      await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "invalid-result" });
      evidence = { reason: "invalid-result", evidence: problems.join("\n") };
      continue;
    }
    await closeAttempt(db, attempt.id, { outcome: "succeeded", result });

    const accepted = PlanResult.parse(result);
    await storePlan(db, { workItemId: item.id, planAttemptId: attempt.id, tasks: accepted.tasks });
    await commitPaths({
      worktree,
      paths: [`${changeFolder(item.changeId)}/tasks.md`],
      ...(ctx.committer === undefined ? {} : { identity: ctx.committer }),
      message: `docs(${item.changeId}): plan the tasks\n\nWritten by the ${ctx.planner.name} role for issue #${String(item.issueNumber)}.`,
    });
    await ctx.forge.pushBranch({ worktree, branch: item.branch });
    const advanced = await setWorkItemState(db, item.id, BUILD);
    return { kind: "advance", workItem: advanced, result, tasks: await unfinished(ctx, advanced) };
  }

  return escalate(ctx, workItem, used, evidence);
}

/** Refuses a work item Plan must not run for yet; see the module comment. */
async function requireReady(ctx: PlanContext, item: WorkItemRow, folder: string): Promise<void> {
  switch (item.state) {
    case PLAN:
      return;
    case "proposal-approved": {
      const reading = readComplexity(await readIfExists(join(folder, ".openspec.yaml")));
      if (!reading.ok) throw new NotApplicable(`work item ${item.changeId} cannot be planned: ${reading.problem}`);
      if (reading.complexity !== "small") throw new NotApplicable(`work item ${item.changeId} is a ${reading.complexity} change, which goes through Design before Plan`);
      return;
    }
    case "awaiting-design-approval":
      if ((await findOpenApproval(ctx.db, item.id)) !== undefined) throw new NotApplicable(`work item ${item.changeId} still has an open design approval`);
      return;
    default:
      throw new NotApplicable(`work item ${item.changeId} is ${item.state}, not ready for Plan`);
  }
}

/** The plan's problems: its schema, then `validatePlan` against the change and the planner's tasks.md. */
async function checkPlan(ctx: PlanContext, result: unknown, folder: string, previous: string | undefined): Promise<string[]> {
  const parsed = PlanResult.safeParse(result);
  if (!parsed.success) return parsed.error.issues.map((issue) => `tasks.json: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const tasksMd = await readIfExists(join(folder, "tasks.md"));
  if (tasksMd === undefined) return ["tasks.md is missing from the change folder"];
  return validatePlan(parsed.data, folder, tasksMd, previous, ctx.planPaths);
}

/** The work item's pending task ids, in plan order. */
async function unfinished(ctx: PlanContext, item: WorkItemRow): Promise<string[]> {
  return (await listTasks(ctx.db, item.id)).filter((task) => task.status === "pending").map((task) => task.taskId);
}

async function escalate(ctx: PlanContext, item: WorkItemRow, used: number, last: RetryEvidence | undefined): Promise<Transition> {
  const reason = last?.reason ?? `no attempts left (${String(used)} used)`;
  const summary =
    last?.reason === "auth-mode-mismatch"
      ? "The plan attempt failed with `auth-mode-mismatch`, which is never retried."
      : `The plan failed ${String(used)} attempts in a row${last === undefined ? "" : `; the last one failed with \`${last.reason}\``}.`;
  const body = [`The factory escalated \`${item.changeId}\` to the owner. ${summary}`, ...(last === undefined ? [] : ["Evidence from the last attempt:", renderEvidence(last.evidence)])].join("\n\n");
  return escalateWith(ctx, item, body, `plan escalated after ${String(used)} attempt(s): ${reason}`);
}

function isOpen(attempt: AttemptRow): boolean {
  return attempt.endedAt === null;
}
