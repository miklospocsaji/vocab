/**
 * Typed queries over the ledger. Ids are Postgres bigints, returned as strings; costs are
 * `numeric`, returned as numbers.
 */
import type { FailureReason } from "@vocab/factory-roles";
import type { Db } from "./db.ts";
import type { TokenUsage } from "./recorder.ts";

export type AuthMode = "api-key" | "subscription";
export type AttemptOutcome = "succeeded" | "failed";

export interface WorkItemRow {
  id: string;
  issueNumber: number;
  changeId: string;
  branch: string;
  state: string;
  /** The Step Functions execution that created it; null for a local run. */
  executionArn: string | null;
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
  /** The role's validated result, on a succeeded attempt only (until M3 moves results to S3). */
  result: unknown;
}

export interface NewAttempt {
  workItemId: string;
  state: string;
  role: string;
}

export type AttemptEnd = { outcome: "succeeded"; result?: unknown } | { outcome: "failed"; failureReason: FailureReason };

export type ApprovalState = "open" | "closed";

export interface ApprovalRow {
  id: string;
  workItemId: string;
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
}

interface ApprovalRecord {
  id: string;
  work_item_id: string;
  state: ApprovalState;
  task_token: string;
  requested_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
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

const WORK_ITEM_COLUMNS = "id, issue_number, change_id, branch, state, execution_arn, created_at, updated_at";
const ATTEMPT_COLUMNS =
  "id, work_item_id, state, role, n, started_at, ended_at, outcome, failure_reason, auth_mode, cost_usd_estimate, result";
const APPROVAL_COLUMNS = "id, work_item_id, state, task_token, requested_at, resolved_at, resolved_by";

function toWorkItem(row: WorkItemRecord): WorkItemRow {
  return {
    id: row.id,
    issueNumber: row.issue_number,
    changeId: row.change_id,
    branch: row.branch,
    state: row.state,
    executionArn: row.execution_arn,
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
    `INSERT INTO attempts (work_item_id, state, role, n)
     SELECT $1, $2, $3, COALESCE(MAX(n), 0) + 1 FROM attempts WHERE work_item_id = $1 AND state = $2
     RETURNING ${ATTEMPT_COLUMNS}`,
    [attempt.workItemId, attempt.state, attempt.role],
  );
  return toAttempt(only(rows, "openAttempt"));
}

/** Closes an open attempt, with the role's result if it succeeded; closing one twice is an error. */
export async function closeAttempt(db: Db, attemptId: string, end: AttemptEnd): Promise<AttemptRow> {
  const failureReason = end.outcome === "failed" ? end.failureReason : null;
  const result = end.outcome === "succeeded" && end.result !== undefined ? JSON.stringify(end.result) : null;
  const { rows } = await db.query<AttemptRecord>(
    `UPDATE attempts SET ended_at = clock_timestamp(), outcome = $2, failure_reason = $3, result = $4::jsonb
     WHERE id = $1 AND ended_at IS NULL
     RETURNING ${ATTEMPT_COLUMNS}`,
    [attemptId, end.outcome, failureReason, result],
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
      `INSERT INTO approvals (work_item_id, state, task_token) VALUES ($1, 'open', $2) RETURNING ${APPROVAL_COLUMNS}`,
      [approval.workItemId, approval.taskToken],
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
