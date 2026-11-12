/**
 * Open PR (add-build-loop design, "Worker states"): once every task is ticked, finds the change
 * branch's open pull request or opens one into `master`, comments its link on the issue, and sets
 * `pr-open`. The body lists the tasks, each role's tokens and estimated cost from the ledger, and
 * the issue. A repeated run reuses the open pull request and, once `pr-open`, comments no more.
 */
import { listAttemptUsage, listAttempts, listTasks, setWorkItemState, type WorkItemRow } from "@vocab/factory-ledger";
import { NotApplicable } from "./approval.ts";
import type { HandlerContext, Transition } from "./handler.ts";

const PR_OPEN = "pr-open";

export interface OpenPrContext extends HandlerContext {
  /** The branch the pull request merges into; defaults to `master`. */
  base?: string;
}

export async function openPr(ctx: OpenPrContext, item: WorkItemRow): Promise<Transition> {
  if (item.state === PR_OPEN) return { kind: "advance", workItem: item };
  if (item.state !== "build") throw new NotApplicable(`work item ${item.changeId} is ${item.state}, not building`);
  const tasks = await listTasks(ctx.db, item.id);
  const pending = tasks.filter((task) => task.status !== "done");
  if (tasks.length === 0 || pending.length > 0) {
    throw new NotApplicable(`work item ${item.changeId} has unfinished tasks: ${pending.map((task) => task.taskId).join(", ") || "no plan"}`);
  }

  const issue = await ctx.forge.getIssue(item.issueNumber);
  const existing = await ctx.forge.findPullRequest(item.branch);
  const pr =
    existing ??
    (await ctx.forge.openPullRequest({
      head: item.branch,
      base: ctx.base ?? "master",
      title: `${item.changeId}: ${issue.title}`,
      body: await renderBody(ctx, item, tasks),
    }));
  await ctx.forge.comment(item.issueNumber, `The factory opened a pull request for \`${item.changeId}\`: ${pr.url}`);
  return { kind: "advance", workItem: await setWorkItemState(ctx.db, item.id, PR_OPEN) };
}

interface RoleCost {
  attempts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  usd: number;
}

async function renderBody(ctx: OpenPrContext, item: WorkItemRow, tasks: Awaited<ReturnType<typeof listTasks>>): Promise<string> {
  const usage = new Map((await listAttemptUsage(ctx.db, item.id)).map((row) => [row.attemptId, row]));
  const roles = new Map<string, RoleCost>();
  for (const attempt of await listAttempts(ctx.db, item.id)) {
    const cost = roles.get(attempt.role) ?? { attempts: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, usd: 0 };
    const tokens = usage.get(attempt.id);
    cost.attempts += 1;
    cost.input += tokens?.inputTokens ?? 0;
    cost.output += tokens?.outputTokens ?? 0;
    cost.cacheRead += tokens?.cacheReadTokens ?? 0;
    cost.cacheCreation += tokens?.cacheCreationTokens ?? 0;
    cost.usd += attempt.costUsdEstimate ?? 0;
    roles.set(attempt.role, cost);
  }
  const total = [...roles.values()].reduce((sum, cost) => sum + cost.usd, 0);
  const n = (value: number) => value.toLocaleString("en-US");

  return [
    `Closes #${String(item.issueNumber)}.`,
    `Built by the factory from the change \`${item.changeId}\`, tests first, one commit per task.`,
    "## Tasks",
    tasks.map((task) => `- [x] ${task.taskId} ${task.title}${task.doneCommit === null ? "" : ` (${task.doneCommit.slice(0, 7)})`}`).join("\n"),
    "## Cost",
    [
      "| Role | Attempts | Input tokens | Output tokens | Cache read tokens | Cache write tokens | Estimated cost |",
      "|---|---:|---:|---:|---:|---:|---:|",
      ...[...roles.entries()].map(
        ([role, cost]) => `| ${role} | ${String(cost.attempts)} | ${n(cost.input)} | ${n(cost.output)} | ${n(cost.cacheRead)} | ${n(cost.cacheCreation)} | $${cost.usd.toFixed(2)} |`,
      ),
      `| **Total** | | | | | | **$${total.toFixed(2)}** |`,
    ].join("\n"),
    "The cost is the SDK's estimate; with a subscription, no money is charged per token.",
  ].join("\n\n");
}
