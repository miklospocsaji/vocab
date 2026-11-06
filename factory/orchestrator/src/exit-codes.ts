/**
 * How a `factory-worker` task reports its outcome, and the escalation reasons the state machine
 * passes to `escalate`. Shared by the worker and the state machine, which routes on them.
 */
export const WORKER_EXIT = {
  /** The state advanced, or there was nothing to do. */
  ok: 0,
  /** Any other error; the state machine retries it. */
  error: 1,
  /** Invalid input; no role ran. The state machine escalates at once. */
  invalid: 2,
  /** The work item escalated. */
  escalated: 3,
  /** The run ends with no work item to continue: a rejected issue, or one with another execution's work item. */
  ended: 4,
} as const;

/** Fixed codes, never environment values or an ECS message (design, "Worker states"). */
export const ESCALATION_REASON = {
  /** A worker task crashed or never ran, and its retries are used up. */
  failed: "worker-failed",
  /** A worker task refused its input (exit 2). */
  refused: "worker-refused",
} as const;

export type EscalationReason = (typeof ESCALATION_REASON)[keyof typeof ESCALATION_REASON];
export const ESCALATION_REASONS: readonly EscalationReason[] = Object.values(ESCALATION_REASON);
