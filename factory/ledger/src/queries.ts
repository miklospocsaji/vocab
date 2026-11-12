/**
 * Typed queries over the ledger. Ids are Postgres bigints, returned as strings; costs are
 * `numeric`, returned as numbers.
 */
import type { FailureReason as RoleFailureReason } from "@vocab/factory-roles";
import pg from "pg";
import type { Db } from "./db.ts";
import type { TokenUsage } from "./recorder.ts";

export type AuthMode = "api-key" | "subscription";
/** Why an attempt failed: a runner reason, a build reason, or a build task that left no outcome. */
export type FailureReason = RoleFailureReason | "diff-check" | "red" | "green" | "no-outcome";
export type AttemptOutcome = "succeeded" | "failed";

export interface WorkItemRow {
  id: string;
  issueNumber: number;
  changeId: string;
  branch: string;
  state: string;
  /** The Step Functions execution that created it; null for a local run. */
  executionArn: string | null;
  /** How many times the build loop sent the change back to Design. */
  designFlaws: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewWorkItem {
  issueNumber: number;
  changeId: string;
  branch: string;
  state: string;
  executionArn?: string;
}

export interface AttemptRow {
  id: string;
  workItemId: string;
  state: string;
  role: string;
  /** 1-based, per work item and state. */
  n: number;
  startedAt: Date;
  endedAt: Date | null;
  outcome: AttemptOutcome | null;
  failureReason: FailureReason | null;
  authMode: AuthMode | null;
  costUsdEstimate: number | null;
  /** The role's validated result, on a succeeded attempt only. */
  result: unknown;
  /** The plan task a build attempt is for; null outside the build loop. */
  taskId: string | null;
  /** The artifact store prefix of a build attempt's input and outputs. */
  storePrefix: string | null;
  /** The failure classifier's label for a failed build attempt. */
  classification: unknown;
  /** The gates result of a build attempt. */
  gates: unknown;
}

export interface NewAttempt {
  workItemId: string;
  state: string;
  role: string;
  taskId?: string;
  storePrefix?: string;
}

export type AttemptEnd =
  | { outcome: "succeeded"; result?: unknown; gates?: unknown }
  | { outcome: "failed"; failureReason: FailureReason; gates?: unknown };

export type ApprovalState = "open" | "closed";
export type ApprovalKind = "proposal" | "design";

export interface ApprovalRow {
  id: string;
  workItemId: string;
  kind: ApprovalKind;
  state: ApprovalState;
  taskToken: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  /** The login that resolved it. */
  resolvedBy: string | null;
}

export interface NewApproval {
  workItemId: string;
  taskToken: string;
  /** Defaults to `proposal`. */
  kind?: ApprovalKind;
}

export type TaskStatus = "pending" | "done" | "superseded";

/** One task of a plan, as the planner's `tasks.json` lists it. */
export interface PlanTaskInput {
  id: string;
  title: string;
  dependsOn: readonly string[];
  files: readonly string[];
  scenarios: readonly string[];
  tests: readonly string[];
}

export interface TaskRow {
  id: string;
  workItemId: string;
  /** The id in `tasks.md`, such as `1.2`. */
  taskId: string;
  /** 1-based, in the plan's order. */
  position: number;
  title: string;
  dependsOn: string[];
  files: string[];
  scenarios: string[];
  tests: string[];
  status: TaskStatus;
  /** The commit that ticked it. */
  doneCommit: string | null;
  /** The planner attempt whose plan it came from. */
  planAttemptId: string;
}

export interface NewPlan {
  workItemId: string;
  planAttemptId: string;
  tasks: readonly PlanTaskInput[];
}

export interface MessageRow {
  id: string;
  attemptId: string;
  seq: number;
  type: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  raw: unknown;
}

export class ChangeIdTaken extends Error {
  readonly changeId: string;

  constructor(changeId: string, options?: ErrorOptions) {
    super(`change id ${changeId} is taken by another work item`, options);
    this.name = "ChangeIdTaken";
    this.changeId = changeId;
  }
}

export class IssueHasWorkItem extends Error {
  readonly issueNumber: number;

  constructor(issueNumber: number, options?: ErrorOptions) {
    super(`issue #${String(issueNumber)} has a work item already`, options);
    this.name = "IssueHasWorkItem";
    this.issueNumber = issueNumber;
  }
}

export class ApprovalAlreadyOpen extends Error {
  readonly workItemId: string;

  constructor(workItemId: string, options?: ErrorOptions) {
    super(`work item ${workItemId} has an open approval already`, options);
    this.name = "ApprovalAlreadyOpen";
    this.workItemId = workItemId;
  }
}

const UNIQUE_VIOLATION = "23505";
const CHANGE_ID_KEY = "work_items_change_id_key";
const ISSUE_NUMBER_KEY = "work_items_issue_number_key";
const ONE_OPEN_APPROVAL = "approvals_one_open_idx";

interface WorkItemRecord {
  id: string;
  issue_number: number;
  change_id: string;
  branch: string;
  state: string;
  execution_arn: string | null;
  design_flaws: number;
  created_at: Date;
  updated_at: Date;
}

interface AttemptRecord {
  id: string;
  work_item_id: string;
  state: string;
  role: string;
  n: number;
  started_at: Date;
  ended_at: Date | null;
  outcome: AttemptOutcome | null;
  failure_reason: FailureReason | null;
  auth_mode: AuthMode | null;
  cost_usd_estimate: string | null;
  result: unknown;
  task_id: string | null;
  store_prefix: string | null;
  classification: unknown;
  gates: unknown;
}

interface ApprovalRecord {
  id: string;
  work_item_id: string;
  kind: ApprovalKind;
  state: ApprovalState;
  task_token: string;
  requested_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}

interface TaskRecord {
  id: string;
  work_item_id: string;
  task_id: string;
  position: number;
  title: string;
  depends_on: string[];
  files: string[];
  scenarios: string[];
  tests: string[];
  status: TaskStatus;
  done_commit: string | null;
  plan_attempt_id: string;
}

interface MessageRecord {
  id: string;
  attempt_id: string;
  seq: number;
  type: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  raw: unknown;
}

const WORK_ITEM_COLUMNS = "id, issue_number, change_id, branch, state, execution_arn, design_flaws, created_at, updated_at";
const ATTEMPT_COLUMNS =
  "id, work_item_id, state, role, n, started_at, ended_at, outcome, failure_reason, auth_mode, cost_usd_estimate, result, task_id, store_prefix, classification, gates";
const APPROVAL_COLUMNS = "id, work_item_id, kind, state, task_token, requested_at, resolved_at, resolved_by";
const TASK_COLUMNS = "id, work_item_id, task_id, position, title, depends_on, files, scenarios, tests, status, done_commit, plan_attempt_id";

function toWorkItem(row: WorkItemRecord): WorkItemRow {
  return {
    id: row.id,
    issueNumber: row.issue_number,
    changeId: row.change_id,
    branch: row.branch,
    state: row.state,
    executionArn: row.execution_arn,
    designFlaws: row.design_flaws,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRecord): AttemptRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    state: row.state,
    role: row.role,
    n: row.n,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    failureReason: row.failure_reason,
    authMode: row.auth_mode,
    costUsdEstimate: row.cost_usd_estimate === null ? null : Number(row.cost_usd_estimate),
    result: row.result,
    taskId: row.task_id,
    storePrefix: row.store_prefix,
    classification: row.classification,
    gates: row.gates,
  };
}

function toTask(row: TaskRecord): TaskRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    taskId: row.task_id,
    position: row.position,
    title: row.title,
    dependsOn: row.depends_on,
    files: row.files,
    scenarios: row.scenarios,
    tests: row.tests,
    status: row.status,
    doneCommit: row.done_commit,
    planAttemptId: row.plan_attempt_id,
  };
}

function toMessage(row: MessageRecord): MessageRow {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    seq: row.seq,
    type: row.type,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    raw: row.raw,
  };
}

function toApproval(row: ApprovalRecord): ApprovalRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    kind: row.kind,
    state: row.state,
    taskToken: row.task_token,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

function only<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (row === undefined) throw new Error(`${what}: no row`);
  return row;
}

/**
 * Rejects with ChangeIdTaken when another work item has the change id, and with
 * IssueHasWorkItem when the issue has one already (a concurrent Intake that lost).
 */
export async function createWorkItem(db: Db, item: NewWorkItem): Promise<WorkItemRow> {
  try {
    const { rows } = await db.query<WorkItemRecord>(
      `INSERT INTO work_items (issue_number, change_id, branch, state, execution_arn) VALUES ($1, $2, $3, $4, $5) RETURNING ${WORK_ITEM_COLUMNS}`,
      [item.issueNumber, item.changeId, item.branch, item.state, item.executionArn ?? null],
    );
    return toWorkItem(only(rows, "createWorkItem"));
  } catch (error) {
    if (isUniqueViolation(error, CHANGE_ID_KEY)) throw new ChangeIdTaken(item.changeId, { cause: error });
    if (isUniqueViolation(error, ISSUE_NUMBER_KEY)) throw new IssueHasWorkItem(item.issueNumber, { cause: error });
    throw error;
  }
}

/** The issue's work item; an issue has at most one (migration 0002). */
export async function findWorkItemByIssue(db: Db, issueNumber: number): Promise<WorkItemRow | undefined> {
  const { rows } = await db.query<WorkItemRecord>(
    `SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE issue_number = $1 ORDER BY id DESC LIMIT 1`,
    [issueNumber],
  );
  return rows[0] === undefined ? undefined : toWorkItem(rows[0]);
}

export async function findWorkItemByChangeId(db: Db, changeId: string): Promise<WorkItemRow | undefined> {
  const { rows } = await db.query<WorkItemRecord>(`SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE change_id = $1`, [changeId]);
  return rows[0] === undefined ? undefined : toWorkItem(rows[0]);
}

/** Moves the work item to `state` and returns it; a missing work item is an error. */
export async function setWorkItemState(db: Db, workItemId: string, state: string): Promise<WorkItemRow> {
  const { rows } = await db.query<WorkItemRecord>(
    `UPDATE work_items SET state = $2, updated_at = now() WHERE id = $1 RETURNING ${WORK_ITEM_COLUMNS}`,
    [workItemId, state],
  );
  if (rows[0] === undefined) throw new Error(`work item ${workItemId} not found`);
  return toWorkItem(rows[0]);
}

/** Opens the next attempt for the work item's state, numbered from 1. */
export async function openAttempt(db: Db, attempt: NewAttempt): Promise<AttemptRow> {
  const { rows } = await db.query<AttemptRecord>(
    `INSERT INTO attempts (work_item_id, state, role, n, task_id, store_prefix)
     SELECT $1, $2, $3, COALESCE(MAX(n), 0) + 1, $4, $5 FROM attempts WHERE work_item_id = $1 AND state = $2
     RETURNING ${ATTEMPT_COLUMNS}`,
    [attempt.workItemId, attempt.state, attempt.role, attempt.taskId ?? null, attempt.storePrefix ?? null],
  );
  return toAttempt(only(rows, "openAttempt"));
}

/** Closes an open attempt, with the role's result if it succeeded; closing one twice is an error. */
export async function closeAttempt(db: Db, attemptId: string, end: AttemptEnd): Promise<AttemptRow> {
  const failureReason = end.outcome === "failed" ? end.failureReason : null;
  const result = end.outcome === "succeeded" && end.result !== undefined ? JSON.stringify(end.result) : null;
  const gates = end.gates === undefined ? null : JSON.stringify(end.gates);
  const { rows } = await db.query<AttemptRecord>(
    `UPDATE attempts SET ended_at = clock_timestamp(), outcome = $2, failure_reason = $3, result = $4::jsonb, gates = $5::jsonb
     WHERE id = $1 AND ended_at IS NULL
     RETURNING ${ATTEMPT_COLUMNS}`,
    [attemptId, end.outcome, failureReason, result, gates],
  );
  if (rows[0] === undefined) throw new Error(`attempt ${attemptId} is not open`);
  return toAttempt(rows[0]);
}

export async function listAttempts(db: Db, workItemId: string): Promise<AttemptRow[]> {
  const { rows } = await db.query<AttemptRecord>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE work_item_id = $1 ORDER BY id`, [
    workItemId,
  ]);
  return rows.map(toAttempt);
}

export async function listMessages(db: Db, attemptId: string): Promise<MessageRow[]> {
  const { rows } = await db.query<MessageRecord>(
    `SELECT id, attempt_id, seq, type, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw
     FROM messages WHERE attempt_id = $1 ORDER BY seq`,
    [attemptId],
  );
  return rows.map(toMessage);
}

/** The work item's estimated cost in USD: the sum over its attempts; attempts without an estimate count as 0. */
export async function workItemCost(db: Db, workItemId: string): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    "SELECT COALESCE(SUM(cost_usd_estimate), 0) AS total FROM attempts WHERE work_item_id = $1",
    [workItemId],
  );
  return Number(only(rows, "workItemCost").total);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

/** An attempt's token usage: the sum over its result messages, which carry each session's totals. */
export interface AttemptUsage extends TokenUsage {
  attemptId: string;
}

/** Token usage per attempt of the work item, in attempt order; an attempt without a result message has zeros. */
export async function listAttemptUsage(db: Db, workItemId: string): Promise<AttemptUsage[]> {
  const { rows } = await db.query<{ attempt_id: string; input: string; output: string; cache_read: string; cache_creation: string }>(
    `SELECT a.id AS attempt_id,
            COALESCE(SUM(m.input_tokens), 0) AS input,
            COALESCE(SUM(m.output_tokens), 0) AS output,
            COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
            COALESCE(SUM(m.cache_creation_tokens), 0) AS cache_creation
     FROM attempts a LEFT JOIN messages m ON m.attempt_id = a.id AND m.type = 'result'
     WHERE a.work_item_id = $1
     GROUP BY a.id ORDER BY a.id`,
    [workItemId],
  );
  return rows.map((row) => ({
    attemptId: row.attempt_id,
    inputTokens: Number(row.input),
    outputTokens: Number(row.output),
    cacheReadTokens: Number(row.cache_read),
    cacheCreationTokens: Number(row.cache_creation),
  }));
}

/** Stores an open approval with its task token; rejects with ApprovalAlreadyOpen if one is open. */
export async function openApproval(db: Db, approval: NewApproval): Promise<ApprovalRow> {
  try {
    const { rows } = await db.query<ApprovalRecord>(
      `INSERT INTO approvals (work_item_id, kind, state, task_token) VALUES ($1, $2, 'open', $3) RETURNING ${APPROVAL_COLUMNS}`,
      [approval.workItemId, approval.kind ?? "proposal", approval.taskToken],
    );
    return toApproval(only(rows, "openApproval"));
  } catch (error) {
    if (isUniqueViolation(error, ONE_OPEN_APPROVAL)) throw new ApprovalAlreadyOpen(approval.workItemId, { cause: error });
    throw error;
  }
}

export async function findOpenApproval(db: Db, workItemId: string): Promise<ApprovalRow | undefined> {
  const { rows } = await db.query<ApprovalRecord>(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE work_item_id = $1 AND state = 'open'`, [
    workItemId,
  ]);
  return rows[0] === undefined ? undefined : toApproval(rows[0]);
}

/**
 * Closes the work item's open approval, resolved by `resolvedBy`, and returns it with its task
 * token. One statement, so of two concurrent closes only one gets the approval; the other, and
 * a close with nothing open, get undefined.
 */
export async function closeApproval(db: Db, workItemId: string, resolvedBy: string): Promise<ApprovalRow | undefined> {
  const { rows } = await db.query<ApprovalRecord>(
    `UPDATE approvals SET state = 'closed', resolved_at = clock_timestamp(), resolved_by = $2
     WHERE work_item_id = $1 AND state = 'open'
     RETURNING ${APPROVAL_COLUMNS}`,
    [workItemId, resolvedBy],
  );
  return rows[0] === undefined ? undefined : toApproval(rows[0]);
}

/**
 * Opens a closed approval again, so the owner can retry after resuming the execution failed.
 * Rejects with ApprovalAlreadyOpen if the work item has another open approval.
 */
export async function reopenApproval(db: Db, approvalId: string): Promise<ApprovalRow> {
  let rows: ApprovalRecord[];
  try {
    ({ rows } = await db.query<ApprovalRecord>(
      `UPDATE approvals SET state = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = $1 RETURNING ${APPROVAL_COLUMNS}`,
      [approvalId],
    ));
  } catch (error) {
    if (isUniqueViolation(error, ONE_OPEN_APPROVAL)) {
      const workItemId = (await db.query<{ work_item_id: string }>("SELECT work_item_id FROM approvals WHERE id = $1", [approvalId])).rows[0]?.work_item_id;
      throw new ApprovalAlreadyOpen(workItemId ?? "unknown", { cause: error });
    }
    throw error;
  }
  if (rows[0] === undefined) throw new Error(`approval ${approvalId} not found`);
  return toApproval(rows[0]);
}


/** The classifier's label for a build attempt; a missing attempt is an error. */
export async function setAttemptClassification(db: Db, attemptId: string, classification: unknown): Promise<AttemptRow> {
  const { rows } = await db.query<AttemptRecord>(`UPDATE attempts SET classification = $2::jsonb WHERE id = $1 RETURNING ${ATTEMPT_COLUMNS}`, [
    attemptId,
    JSON.stringify(classification),
  ]);
  if (rows[0] === undefined) throw new Error(`attempt ${attemptId} not found`);
  return toAttempt(rows[0]);
}

/** Counts one more design flaw on the work item and returns it; a missing work item is an error. */
export async function incrementDesignFlaws(db: Db, workItemId: string): Promise<WorkItemRow> {
  const { rows } = await db.query<WorkItemRecord>(
    `UPDATE work_items SET design_flaws = design_flaws + 1, updated_at = now() WHERE id = $1 RETURNING ${WORK_ITEM_COLUMNS}`,
    [workItemId],
  );
  if (rows[0] === undefined) throw new Error(`work item ${workItemId} not found`);
  return toWorkItem(rows[0]);
}

/**
 * Stores an accepted plan's tasks and returns the work item's live tasks. The unfinished rows of
 * an earlier plan are superseded; done rows stay as they are, and a plan entry with a done
 * task's id keeps that row. Runs in one transaction.
 */
export async function storePlan(db: Db, plan: NewPlan): Promise<TaskRow[]> {
  await inTransaction(db, async (client) => {
    await client.query("UPDATE tasks SET status = 'superseded' WHERE work_item_id = $1 AND status = 'pending'", [plan.workItemId]);
    const { rows } = await client.query<{ task_id: string }>("SELECT task_id FROM tasks WHERE work_item_id = $1 AND status = 'done'", [plan.workItemId]);
    const done = new Set(rows.map((row) => row.task_id));
    for (const [index, task] of plan.tasks.entries()) {
      if (done.has(task.id)) continue;
      await client.query(
        `INSERT INTO tasks (work_item_id, task_id, position, title, depends_on, files, scenarios, tests, status, plan_attempt_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, 'pending', $9)`,
        [
          plan.workItemId,
          task.id,
          index + 1,
          task.title,
          JSON.stringify(task.dependsOn),
          JSON.stringify(task.files),
          JSON.stringify(task.scenarios),
          JSON.stringify(task.tests),
          plan.planAttemptId,
        ],
      );
    }
  });
  return listTasks(db, plan.workItemId);
}

/** The work item's live (not superseded) tasks, in plan order. */
export async function listTasks(db: Db, workItemId: string): Promise<TaskRow[]> {
  const { rows } = await db.query<TaskRecord>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE work_item_id = $1 AND status <> 'superseded' ORDER BY position, id`,
    [workItemId],
  );
  return rows.map(toTask);
}

/** Marks a pending task done with the commit that ticked it; any other task is an error. */
export async function markTaskDone(db: Db, workItemId: string, taskId: string, commit: string): Promise<TaskRow> {
  const { rows } = await db.query<TaskRecord>(
    `UPDATE tasks SET status = 'done', done_commit = $3 WHERE work_item_id = $1 AND task_id = $2 AND status = 'pending' RETURNING ${TASK_COLUMNS}`,
    [workItemId, taskId, commit],
  );
  if (rows[0] === undefined) throw new Error(`task ${taskId} of work item ${workItemId} is not pending`);
  return toTask(rows[0]);
}

/** Runs `fn` in a transaction: on a client of its own for a pool, or in the caller's for a client. */
async function inTransaction(db: Db, fn: (client: pg.PoolClient | pg.Client) => Promise<void>): Promise<void> {
  if (!(db instanceof pg.Pool)) {
    await fn(db);
    return;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
