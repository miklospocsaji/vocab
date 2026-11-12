/**
 * Step (add-build-loop design, "Worker states"): one move of a task's build, rebuilt from the
 * ledger every time, so a repeated or retried `step` is safe.
 *
 * 1. Record the task's open build attempt, if any: its `outcome.json`, `messages.jsonl` and
 *    gates result. The patch is re-checked against the role's writable globs; a passed one is
 *    applied, committed as the bot and pushed (the implementer's with the task's tick), and an
 *    implementer's ticks the task in the ledger. A failed green gate is labelled by the failure
 *    classifier; other failures are labelled here, without a classifier. A build that left no
 *    outcome is `no-outcome`, labelled `infra`.
 * 2. Decide from the task's attempts what comes next: a ticked task is done; a design flaw sends
 *    the work item back to Design; too many failures escalate; otherwise the next build's
 *    `input.json` and the task's `next.json` are written, then its attempt is opened.
 *
 * Limits per task: MAX_TEST_AUTHOR_ATTEMPTS failed test author attempts, MAX_IMPLEMENTER_ATTEMPTS
 * implementer sessions and MAX_INFRA_FAILURES `infra` labels. Builds after `infra` and the
 * gates-only re-run after the first `flaky` count toward neither role's limit.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { BuildOutcome, ClassificationResult, GatesResult } from "@vocab/factory-artifacts";
import {
  closeAttempt,
  incrementDesignFlaws,
  LedgerRecorder,
  listAttempts,
  listMessages,
  listTasks,
  markTaskDone,
  openAttempt,
  setAttemptClassification,
  setWorkItemState,
  type AttemptRow,
  type FailureReason,
  type TaskRow,
  type WorkItemRow,
} from "@vocab/factory-ledger";
import { AttemptFailed, isWritable, renderClassifierPrompt, replayMessages, writableFor, type RetryEvidence, type Role, type RunRole } from "@vocab/factory-roles";
import { NotApplicable } from "./approval.ts";
import { nextBuildKey, taskPrefix, type ArtifactStore, type NextBuild } from "./build-io.ts";
import { classificationOf, failedChecks } from "./design-flaw.ts";
import { escalateWith } from "./escalation.ts";
import { fence } from "./evidence.ts";
import { commitPaths, ensureWorktree, type GitIdentity } from "./git.ts";
import type { HandlerContext } from "./handler.ts";

const run = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

/** Test author attempts per task before the work item escalates. */
export const MAX_TEST_AUTHOR_ATTEMPTS = 3;
/** Implementer sessions per task before the work item escalates. */
export const MAX_IMPLEMENTER_ATTEMPTS = 3;
/** `infra` failures per task: the first two wait and build again, the third escalates. */
export const MAX_INFRA_FAILURES = 3;
/** Design flaws per work item: the next one escalates. */
export const MAX_DESIGN_FLAWS = 2;

const BUILD = "build";
/** The trailer that ties a task commit to the build attempt it came from, so a repeated step finds it. */
const ATTEMPT_TRAILER = "Factory-Attempt";

export interface StepContext extends HandlerContext {
  /** Runs the failure classifier, which runs in the worker. */
  runRole: RunRole;
  classifier: Role;
  /** The build roles, for their names and writable globs. */
  testAuthor: Role;
  implementer: Role;
  store: ArtifactStore;
  /** What the build container clones, with no token. */
  cloneUrl: string;
  /** The local clone the work item's worktree is added to. */
  repo: string;
  /** The factory's home directory; defaults to `factoryHome()`. */
  home?: string;
  /** The author and committer of task commits; defaults to `FACTORY_GIT_IDENTITY`. */
  committer?: GitIdentity;
}

/**
 * - `done`: the task is ticked (exit 0).
 * - `build`: the next build's input is written; `afterWait` asks for a wait first (exit 20 or 21).
 * - `design-flaw`: the work item goes back to Design (exit 13).
 * - `escalate`: the work item is escalated (exit 3).
 */
export type StepResult =
  | { kind: "done"; workItem: WorkItemRow }
  | { kind: "build"; workItem: WorkItemRow; afterWait: boolean }
  | { kind: "design-flaw"; workItem: WorkItemRow }
  | { kind: "escalate"; workItem: WorkItemRow; reason: string };

export async function step(ctx: StepContext, item: WorkItemRow, taskId: string): Promise<StepResult> {
  const task = await findTask(ctx, item, taskId);
  if (task.status === "done") return { kind: "done", workItem: item };
  if (item.state !== BUILD) throw new NotApplicable(`work item ${item.changeId} is ${item.state}, not building`);

  const worktree = await ensureWorktree({ repo: ctx.repo, changeId: item.changeId, branch: item.branch, ...(ctx.home === undefined ? {} : { home: ctx.home }) });
  await syncWorktree(worktree, item.branch);

  for (const attempt of (await taskAttempts(ctx, item, task)).filter((a) => a.endedAt === null)) {
    if (attempt.role === ctx.classifier.name) await closeAttempt(ctx.db, attempt.id, { outcome: "failed", failureReason: "error" });
    else await record(ctx, item, task, attempt, worktree);
  }

  const current = await findTask(ctx, item, taskId);
  if (current.status === "done") return { kind: "done", workItem: item };
  return decide(ctx, item, current, worktree);
}

async function findTask(ctx: StepContext, item: WorkItemRow, taskId: string): Promise<TaskRow> {
  const task = (await listTasks(ctx.db, item.id)).find((row) => row.taskId === taskId);
  if (task === undefined) throw new NotApplicable(`task ${taskId} is not in the plan of ${item.changeId}`);
  return task;
}

/** The task's attempts since its plan, in order: build attempts and classifier attempts. */
async function taskAttempts(ctx: StepContext, item: WorkItemRow, task: TaskRow): Promise<AttemptRow[]> {
  const since = BigInt(task.planAttemptId);
  return (await listAttempts(ctx.db, item.id)).filter((attempt) => attempt.state === BUILD && attempt.taskId === task.taskId && BigInt(attempt.id) > since);
}

// ---------------------------------------------------------------------------------------------
// Recording a build outcome

async function record(ctx: StepContext, item: WorkItemRow, task: TaskRow, attempt: AttemptRow, worktree: string): Promise<void> {
  const { db, store } = ctx;
  const prefix = attempt.storePrefix ?? "";
  const role = attempt.role === ctx.testAuthor.name ? ctx.testAuthor : ctx.implementer;

  const outcomeKey = `${prefix}/outcome.json`;
  const outcome = (await store.exists(outcomeKey)) ? BuildOutcome.safeParse(parseJson(await store.get(outcomeKey))) : undefined;
  if (outcome === undefined || !outcome.success) {
    const evidence = outcome === undefined ? "The build task ended without writing outcome.json." : `The build task's outcome.json is invalid: ${outcome.error.message}`;
    await setAttemptClassification(db, attempt.id, { kind: "infra", evidence });
    await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "no-outcome" });
    return;
  }
  const result = outcome.data;

  // The messages first, so the cost is recorded whatever comes next; a repeat finds them there.
  if ((await listMessages(db, attempt.id)).length === 0 && (await store.exists(result.messages))) {
    await replayMessages(await store.get(result.messages), item.id, attempt.role, new LedgerRecorder(db));
  }
  const gates = result.gates === undefined ? undefined : GatesResult.parse(parseJson(await store.get(result.gates)));
  const patch = await store.get(result.patch);
  const base = (await readInput(store, prefix)).baseCommit;

  // The worker's re-check of the patch is the boundary: the outcome's own diff check is not trusted.
  const paths = await patchPaths(worktree, patch);
  const stubs = role.writable.includes("{taskStubs}") ? await newFiles(worktree, base, task.files) : [];
  const globs = writableFor(role, item.changeId, stubs);
  const outside = [];
  for (const path of paths) if (!isWritable(path, globs) || (stubs.includes(path) && (await existsAt(worktree, base, path)))) outside.push(path);
  const withGates = gates === undefined ? {} : { gates };

  if (outside.length > 0) {
    await setAttemptClassification(db, attempt.id, {
      kind: "bug",
      evidence: `The patch changes paths outside the ${role.name}'s writable paths, so nothing of it was committed: ${outside.sort().join(", ")}.`,
    });
    await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: "diff-check", ...withGates });
    return;
  }

  if (result.outcome === "passed") {
    const commit = await commitBuild(ctx, item, task, attempt, worktree, patch, paths, base);
    if (role === ctx.implementer) await markTaskDone(db, item.id, task.taskId, commit);
    await closeAttempt(db, attempt.id, { outcome: "succeeded", ...(result.roleResult === undefined ? {} : { result: result.roleResult }), ...withGates });
    return;
  }

  const reason: FailureReason = result.reason ?? "error";
  if (role === ctx.implementer && reason === "green" && gates !== undefined) {
    await setAttemptClassification(db, attempt.id, await classify(ctx, item, task, gates, paths, worktree));
  } else if (role === ctx.implementer || reason === "diff-check") {
    // Failures before the gates count as `bug`, with no classifier call.
    await setAttemptClassification(db, attempt.id, { kind: "bug", evidence: reasonEvidence(reason, result.diffCheck.outside) });
  }
  await closeAttempt(db, attempt.id, { outcome: "failed", failureReason: reason, ...withGates });
}

function reasonEvidence(reason: string, outside: readonly string[]): string {
  if (reason === "diff-check") return `The attempt changed paths outside its writable paths: ${outside.join(", ")}.`;
  return `The attempt failed with \`${reason}\` before its gates ran.`;
}

/** Runs the failure classifier on a failed green gate; a classifier that fails leaves the failure a `bug`. */
async function classify(ctx: StepContext, item: WorkItemRow, task: TaskRow, gates: GatesResult, paths: readonly string[], worktree: string): Promise<ClassificationResult> {
  const attempt = await openAttempt(ctx.db, { workItemId: item.id, state: BUILD, role: ctx.classifier.name, taskId: task.taskId });
  const prompt = renderClassifierPrompt({ changeId: item.changeId, task: { id: task.taskId, title: task.title, scenarios: task.scenarios }, gates, changedPaths: paths });
  try {
    const result = ClassificationResult.parse(
      await ctx.runRole(ctx.classifier, { id: item.id, changeId: item.changeId, worktree, issue: { title: "", body: "" }, changeFiles: [], specs: [], prompt }),
    );
    await closeAttempt(ctx.db, attempt.id, { outcome: "succeeded", result });
    return result;
  } catch (error) {
    const reason: FailureReason = error instanceof AttemptFailed ? error.reason : "error";
    await closeAttempt(ctx.db, attempt.id, { outcome: "failed", failureReason: reason });
    if (!(error instanceof AttemptFailed)) throw error;
    return { kind: "bug", evidence: `The failure classifier failed with \`${reason}\`, so the failure counts as a bug.` };
  }
}

/**
 * Applies a passed build's patch in the work item's worktree, commits it as the bot and pushes.
 * The implementer's commit also ticks the task in `tasks.md`. A commit that a crashed step already
 * made for this attempt is found by its trailer and pushed again, not made twice.
 */
async function commitBuild(ctx: StepContext, item: WorkItemRow, task: TaskRow, attempt: AttemptRow, worktree: string, patch: string, paths: readonly string[], base: string): Promise<string> {
  const head = await git(worktree, "rev-parse", "HEAD");
  const made = await git(worktree, "log", "-1", "--format=%H", "--extended-regexp", `--grep=^${ATTEMPT_TRAILER}: ${attempt.id}$`, `${base}..HEAD`);
  let commit = made === "" ? undefined : made;

  if (commit === undefined) {
    const implementing = attempt.role === ctx.implementer.name;
    await applyPatch(worktree, patch);
    const tasksMd = `openspec/changes/${item.changeId}/tasks.md`;
    if (implementing) await tick(join(worktree, tasksMd), task.taskId);
    const subject = implementing ? `feat(${item.changeId}): task ${task.taskId} ${task.title}` : `test(${item.changeId}): tests for task ${task.taskId}`;
    const message = `${subject}\n\nWritten by the ${attempt.role} role for issue #${String(item.issueNumber)}.\n\n${ATTEMPT_TRAILER}: ${attempt.id}`;
    commit = await commitPaths({ worktree, paths: implementing ? [...paths, tasksMd] : paths, message, ...(ctx.committer === undefined ? {} : { identity: ctx.committer }) });
  }
  await ctx.forge.pushBranch({ worktree, branch: item.branch });
  return commit ?? head;
}

/** Ticks the task's line, `- [ ] <id> …`; a line that is ticked already stays as it is. */
async function tick(file: string, taskId: string): Promise<void> {
  const text = await readFile(file, "utf8");
  const id = taskId.replaceAll(".", "\\.");
  const open = new RegExp(`^(\\s*- )\\[ \\]( ${id}(?:\\s|$))`, "m");
  if (open.test(text)) {
    await writeFile(file, text.replace(open, "$1[x]$2"));
    return;
  }
  if (!new RegExp(`^\\s*- \\[[xX]\\] ${id}(?:\\s|$)`, "m").test(text)) throw new Error(`tasks.md has no line for task ${taskId}`);
}

// ---------------------------------------------------------------------------------------------
// Deciding the next move

interface History {
  /** The test author's tests are committed. */
  tested: boolean;
  testFailures: number;
  sessions: number;
  infra: number;
  /** The evidence for the next attempt of the current role. */
  evidence: RetryEvidence | undefined;
  /** The last failure's label, `infra` asking for a wait. */
  last: { kind: string; evidence: string; attempt: AttemptRow } | undefined;
  /** How the next implementer build runs, and the session attempt a gates-only run re-checks. */
  mode: "session" | "gates-only";
  session: AttemptRow | undefined;
  flakyUsed: boolean;
}

function replay(ctx: StepContext, attempts: readonly AttemptRow[]): History {
  const h: History = { tested: false, testFailures: 0, sessions: 0, infra: 0, evidence: undefined, last: undefined, mode: "session", session: undefined, flakyUsed: false };
  for (const attempt of attempts) {
    if (attempt.role !== ctx.testAuthor.name && attempt.role !== ctx.implementer.name) continue;
    const label = classificationOf(attempt);
    h.last = label === undefined ? undefined : { ...label, attempt };
    if (attempt.outcome === "succeeded") {
      // Only the test author gets here: a passed implementer ticked the task.
      Object.assign(h, { tested: true, evidence: undefined, mode: "session" });
      continue;
    }
    if (label?.kind === "infra") {
      h.infra += 1;
      continue;
    }
    if (attempt.role === ctx.testAuthor.name) {
      h.testFailures += 1;
      h.evidence = evidenceOf(attempt, label);
      continue;
    }
    if (h.mode === "session") {
      h.sessions += 1;
      h.session = attempt;
    }
    if (label?.kind === "flaky" && !h.flakyUsed && h.session !== undefined) {
      h.flakyUsed = true;
      h.mode = "gates-only";
      continue;
    }
    if (label?.kind === "flaky") h.flakyUsed = true;
    h.mode = "session";
    h.evidence = evidenceOf(attempt, label);
  }
  return h;
}

/** A failed attempt's evidence for the role's next attempt: the failed checks, then the label's evidence. */
function evidenceOf(attempt: AttemptRow, label: { kind: string; evidence: string } | undefined): RetryEvidence {
  const checks = failedChecks(attempt.gates);
  const parts = [
    ...(checks === "" ? [] : [checks]),
    ...(label === undefined || label.evidence === "" ? [] : [label.kind === "bug" ? label.evidence : `The failure classifier labelled the failure \`${label.kind}\`: ${label.evidence}`]),
  ];
  return { reason: attempt.failureReason ?? "error", evidence: parts.length === 0 ? `The attempt failed with \`${attempt.failureReason ?? "error"}\`.` : parts.join("\n\n") };
}

async function decide(ctx: StepContext, item: WorkItemRow, task: TaskRow, worktree: string): Promise<StepResult> {
  const h = replay(ctx, await taskAttempts(ctx, item, task));
  const label = h.last;

  if (label?.kind === "design-flaw") {
    if (item.designFlaws >= MAX_DESIGN_FLAWS) {
      return escalate(ctx, item, `Task ${describe(task)} failed with a design flaw, the ${ordinal(item.designFlaws + 1)} in this work item, so the design goes to the owner.`, label.evidence, "design-flaw limit");
    }
    await incrementDesignFlaws(ctx.db, item.id);
    return { kind: "design-flaw", workItem: await setWorkItemState(ctx.db, item.id, "design") };
  }
  if (label?.kind === "spec-ambiguity") {
    return escalate(ctx, item, `Task ${describe(task)} failed its green gates, and the failure classifier found the spec ambiguous. The owner's answer to this question is needed:`, label.evidence, "spec-ambiguity");
  }
  if (h.infra >= MAX_INFRA_FAILURES) {
    return escalate(ctx, item, `Task ${describe(task)} failed with an infrastructure failure ${String(h.infra)} times. The last one:`, label?.evidence ?? "", "infra");
  }
  const afterWait = label?.kind === "infra";

  if (!h.tested) {
    if (h.testFailures >= MAX_TEST_AUTHOR_ATTEMPTS) {
      return escalate(ctx, item, `Task ${describe(task)}: the test author failed ${String(h.testFailures)} attempts. Evidence from the last one:`, h.evidence?.evidence ?? "", "test-author attempts");
    }
    return writeBuild(ctx, item, task, worktree, { role: ctx.testAuthor.name, mode: "session", evidence: h.evidence, afterWait });
  }

  const sessionPrefix = h.session?.storePrefix;
  if (h.mode === "gates-only" && typeof sessionPrefix === "string") {
    const base = (await readInput(ctx.store, sessionPrefix)).baseCommit;
    return writeBuild(ctx, item, task, worktree, { role: ctx.implementer.name, mode: "gates-only", patch: `${sessionPrefix}/patch.diff`, base, evidence: undefined, afterWait });
  }
  if (h.sessions >= MAX_IMPLEMENTER_ATTEMPTS) {
    const output = h.evidence?.evidence ?? "";
    return escalate(ctx, item, `Task ${describe(task)} failed its green gates in ${String(h.sessions)} implementer attempts. The last gate output:`, output, "implementer attempts");
  }
  return writeBuild(ctx, item, task, worktree, { role: ctx.implementer.name, mode: "session", evidence: h.evidence, afterWait });
}

interface BuildRequest {
  role: string;
  mode: NextBuild["mode"];
  evidence: RetryEvidence | undefined;
  afterWait: boolean;
  /** Gates-only: the patch to re-check and the commit it applies to. */
  patch?: string;
  base?: string;
}

/** Writes the attempt's `input.json` and the task's `next.json`, then opens the attempt: a crash before the open leaves nothing to record. */
async function writeBuild(ctx: StepContext, item: WorkItemRow, task: TaskRow, worktree: string, request: BuildRequest): Promise<StepResult> {
  const { db, store } = ctx;
  // Numbered over every plan's attempts of the task id, so a re-planned task never reuses a prefix.
  const n = (await listAttempts(db, item.id)).filter((attempt) => attempt.taskId === task.taskId && attempt.role === request.role).length + 1;
  const prefix = `${taskPrefix(item.changeId, task.taskId)}/${request.role}/${String(n)}`;
  const implementing = request.role === ctx.implementer.name;
  const covered = implementing
    ? (await listTasks(db, item.id)).filter((row) => row.status === "done" || row.taskId === task.taskId).flatMap((row) => row.scenarios)
    : undefined;

  const input = {
    changeId: item.changeId,
    branch: item.branch,
    baseCommit: request.base ?? (await git(worktree, "rev-parse", "HEAD")),
    cloneUrl: ctx.cloneUrl,
    task: { id: task.taskId, title: task.title, dependsOn: task.dependsOn, files: task.files, scenarios: task.scenarios, tests: task.tests },
    ...(request.evidence === undefined ? {} : { evidence: request.evidence }),
    ...(covered === undefined ? {} : { coveredSoFar: covered }),
  };
  const next: NextBuild = { role: request.role, mode: request.mode, input: `${prefix}/input.json`, ...(request.patch === undefined ? {} : { patch: request.patch }) };
  await store.put(next.input, `${JSON.stringify(input, null, 2)}\n`);
  await store.put(nextBuildKey(item.changeId, task.taskId), `${JSON.stringify(next, null, 2)}\n`);
  await openAttempt(db, { workItemId: item.id, state: BUILD, role: request.role, taskId: task.taskId, storePrefix: prefix });
  return { kind: "build", workItem: item, afterWait: request.afterWait };
}

async function escalate(ctx: StepContext, item: WorkItemRow, summary: string, evidence: string, reason: string): Promise<StepResult> {
  const body = [`The factory escalated \`${item.changeId}\` to the owner. ${summary}`, ...(evidence === "" ? [] : [fence(evidence)])].join("\n\n");
  const transition = await escalateWith(ctx, item, body, reason);
  if (transition.kind !== "escalate") throw new Error("escalation did not escalate");
  return { kind: "escalate", workItem: transition.workItem, reason: transition.reason };
}

const describe = (task: TaskRow): string => `${task.taskId} (${task.title})`;
const ordinal = (n: number): string => (n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${String(n)}th`);

// ---------------------------------------------------------------------------------------------
// Git and store helpers

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
  return stdout.trim();
}

/** Brings the worktree's branch up to the remote's, fast-forward only. */
async function syncWorktree(worktree: string, branch: string): Promise<void> {
  await git(worktree, "fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  const [head, remote] = [await git(worktree, "rev-parse", "HEAD"), await git(worktree, "rev-parse", `refs/remotes/origin/${branch}`)];
  if (head !== remote) await git(worktree, "merge", "--quiet", "--ff-only", `refs/remotes/origin/${branch}`);
}

/** The paths a patch touches, read by git without applying it. */
async function patchPaths(worktree: string, patch: string): Promise<string[]> {
  if (patch.trim() === "") return [];
  return withPatchFile(patch, async (file) => {
    const listed = await run("git", ["apply", "--numstat", "-z", file], { cwd: worktree, encoding: "utf8", maxBuffer: MAX_BUFFER });
    // Entries are `added\tdeleted\tpath`, NUL-terminated (`--no-renames`, so one path each).
    return listed.stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => entry.split("\t").slice(2).join("\t"));
  });
}

async function applyPatch(worktree: string, patch: string): Promise<void> {
  if (patch.trim() === "") return;
  await withPatchFile(patch, (file) => run("git", ["apply", "--binary", file], { cwd: worktree, maxBuffer: MAX_BUFFER }));
}

async function withPatchFile<T>(patch: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "factory-patch-"));
  try {
    const file = join(dir, "patch.diff");
    await writeFile(file, patch);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function existsAt(worktree: string, commit: string, path: string): Promise<boolean> {
  return git(worktree, "cat-file", "-e", `${commit}:${path}`).then(
    () => true,
    () => false,
  );
}

/** The task's files that did not exist at `base`: the test author's stubs, as the build container finds them. */
async function newFiles(worktree: string, base: string, files: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) if (!(await existsAt(worktree, base, file))) found.push(file);
  return found;
}

async function readInput(store: ArtifactStore, prefix: string): Promise<{ baseCommit: string }> {
  const input = parseJson(await store.get(posix.join(prefix, "input.json"))) as { baseCommit?: unknown } | null;
  if (typeof input?.baseCommit !== "string") throw new Error(`${prefix}/input.json has no base commit`);
  return { baseCommit: input.baseCommit };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
