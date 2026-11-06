/**
 * Proposal: runs the proposal-author role on the work item's worktree until it produces a
 * change that passes `openspec validate --strict` and a result that passes its schema, then
 * commits the change folder and pushes the branch. Failed attempts are retried with their
 * evidence, up to MAX_PROPOSAL_ATTEMPTS in total; after that, or at once on an
 * `auth-mode-mismatch` (ADR 0006), the work item escalates and the issue gets a comment.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { closeAttempt, listAttempts, openAttempt, setWorkItemState, type AttemptRow, type WorkItemRow } from "@vocab/factory-ledger";
import { AttemptFailed, type PromptArtifact, type RetryEvidence, type Role, type RunRole, type WorkItem } from "@vocab/factory-roles";
import { commitChange, ensureWorktree, type GitIdentity } from "./git.ts";
import type { HandlerContext, Transition, WorkItemState } from "./handler.ts";

const run = promisify(execFile);

/** The factory's pinned openspec, never one from the worktree. */
const OPENSPEC = resolve(import.meta.dirname, "../../../node_modules/.bin/openspec");

/** Attempts per Proposal, in total, before the work item escalates. */
export const MAX_PROPOSAL_ATTEMPTS = 3;

const PROPOSAL: WorkItemState = "proposal";
const NEXT: WorkItemState = "awaiting-proposal-approval";
const ESCALATED: WorkItemState = "escalated";

export interface ProposalContext extends HandlerContext {
  /** Runs one attempt of a role; the real one is `createRunner` with a LedgerRecorder. */
  runRole: RunRole;
  /** The proposal-author role. */
  role: Role;
  /** The local clone the work item's worktree is added to. */
  repo: string;
  /** The factory's home directory; defaults to `factoryHome()`. */
  home?: string;
  /** The author and committer of the proposal commit; defaults to `FACTORY_GIT_IDENTITY`. */
  committer?: GitIdentity;
}

export async function proposal(ctx: ProposalContext, item: WorkItemRow): Promise<Transition> {
  if (item.state !== PROPOSAL) return { kind: "advance", workItem: item };
  const { db, forge, runRole, role } = ctx;

  const worktree = await ensureWorktree({
    repo: ctx.repo,
    changeId: item.changeId,
    branch: item.branch,
    ...(ctx.home === undefined ? {} : { home: ctx.home }),
  });
  await scaffold(worktree, item.changeId);
  const issue = await forge.getIssue(item.issueNumber);

  // A crash can leave an attempt open; it counts as failed, and toward the limit.
  const previous = (await listAttempts(db, item.id)).filter((attempt) => attempt.state === PROPOSAL);
  for (const attempt of previous.filter(isOpen)) await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "error" });

  let used = previous.length;
  let last: AttemptFailed | undefined;
  while (used < MAX_PROPOSAL_ATTEMPTS) {
    used += 1;
    const evidence: RetryEvidence | undefined = last === undefined ? undefined : { reason: last.reason, evidence: last.evidence };
    const workItem: WorkItem = {
      id: item.id,
      changeId: item.changeId,
      worktree,
      issue: { title: issue.title, body: issue.body },
      changeFiles: await changeFiles(worktree, item.changeId),
      specs: await currentSpecs(worktree),
    };

    const attempt = await openAttempt(db, { workItemId: item.id, state: PROPOSAL, role: role.name });
    let result: unknown;
    try {
      result = await runRole(role, workItem, evidence);
    } catch (error) {
      if (!(error instanceof AttemptFailed)) {
        await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "error" });
        throw error;
      }
      await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: error.reason });
      last = error;
      if (error.reason === "auth-mode-mismatch") break;
      continue;
    }
    // The validated result stays on its attempt, so later states (the summary in the cloud) read it from the ledger.
    await closeAttempt(db, attempt.id, { outcome: "succeeded", result });

    await commitChange({
      worktree,
      changeId: item.changeId,
      ...(ctx.committer === undefined ? {} : { identity: ctx.committer }),
      message: `docs(${item.changeId}): propose the change\n\nWritten by the ${role.name} role for issue #${String(item.issueNumber)}.`,
    });
    await forge.pushBranch({ worktree, branch: item.branch });
    return { kind: "advance", workItem: await setWorkItemState(db, item.id, NEXT), result };
  }

  return escalate(ctx, item, used, last);
}

async function escalate(ctx: ProposalContext, item: WorkItemRow, used: number, last: AttemptFailed | undefined): Promise<Transition> {
  const reason = last === undefined ? `no attempts left (${String(used)} used)` : last.reason;
  const summary =
    last?.reason === "auth-mode-mismatch"
      ? `The proposal attempt failed with \`auth-mode-mismatch\`, which is never retried.`
      : `The proposal failed ${String(used)} attempts in a row${last === undefined ? "" : `; the last one failed with \`${last.reason}\``}.`;
  const body = [
    `The factory escalated \`${item.changeId}\` to the owner. ${summary}`,
    ...(last === undefined ? [] : ["Evidence from the last attempt:", renderEvidence(last.evidence)]),
  ].join("\n\n");
  await ctx.forge.comment(item.issueNumber, body);
  const workItem = await setWorkItemState(ctx.db, item.id, ESCALATED);
  return { kind: "escalate", workItem, reason: `proposal escalated after ${String(used)} attempt(s): ${reason}` };
}

/** `openspec new change <id>`, unless the change folder exists already (a re-run). */
async function scaffold(worktree: string, changeId: string): Promise<void> {
  if (await exists(join(worktree, "openspec/changes", changeId))) return;
  const env = { ...process.env, OPENSPEC_TELEMETRY: "0", PATH: [dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter) };
  await run(OPENSPEC, ["new", "change", changeId], { cwd: worktree, env });
}

/** Every file in the change folder, paths relative to the worktree, sorted. */
async function changeFiles(worktree: string, changeId: string): Promise<PromptArtifact[]> {
  const folder = join(worktree, "openspec/changes", changeId);
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const paths = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return artifacts(worktree, paths);
}

/**
 * The current `openspec/specs/<capability>/spec.md` files. The proposal author decides which
 * capabilities a change affects, so it gets all of them.
 */
async function currentSpecs(worktree: string): Promise<PromptArtifact[]> {
  const specs = join(worktree, "openspec/specs");
  if (!(await exists(specs))) return [];
  const capabilities = await readdir(specs, { withFileTypes: true });
  const paths = capabilities.filter((entry) => entry.isDirectory()).map((entry) => join(specs, entry.name, "spec.md"));
  const present = await Promise.all(paths.map(async (path) => ((await exists(path)) ? [path] : [])));
  return artifacts(worktree, present.flat());
}

async function artifacts(worktree: string, paths: string[]): Promise<PromptArtifact[]> {
  const sorted = paths.map((path) => relative(worktree, path)).sort();
  return Promise.all(sorted.map(async (path) => ({ path, content: await readFile(join(worktree, path), "utf8") })));
}

function isOpen(attempt: AttemptRow): boolean {
  return attempt.endedAt === null;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * An `openspec validate --json` report as a list of its issues; any other evidence as it is,
 * fenced.
 */
function renderEvidence(evidence: string): string {
  const issues = validationIssues(evidence);
  if (issues === undefined || issues.length === 0) return fence(evidence);
  return issues.map((issue) => `- ${issue.level} \`${issue.path}\`: ${issue.message}`).join("\n");
}

interface ValidationIssue {
  level: string;
  path: string;
  message: string;
}

function validationIssues(evidence: string): ValidationIssue[] | undefined {
  let report: unknown;
  try {
    report = JSON.parse(evidence);
  } catch {
    return undefined;
  }
  const items = (report as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  const issues: ValidationIssue[] = [];
  for (const item of items as { issues?: unknown }[]) {
    if (!Array.isArray(item.issues)) return undefined;
    for (const issue of item.issues as Partial<Record<keyof ValidationIssue, unknown>>[]) {
      if (typeof issue.message !== "string") return undefined;
      issues.push({
        level: typeof issue.level === "string" ? issue.level : "ERROR",
        path: typeof issue.path === "string" ? issue.path : "",
        message: issue.message,
      });
    }
  }
  return issues;
}

/** A backtick fence longer than any backtick run in the content, so the content cannot close it. */
function fence(content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${content.replace(/\n+$/, "")}\n${ticks}`;
}
