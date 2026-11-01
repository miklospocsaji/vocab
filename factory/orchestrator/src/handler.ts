/**
 * What every state handler shares. Handlers are plain async functions `(ctx, item) =>
 * Promise<Transition>` with no AWS-specific control flow (ADR 0002): the M1 CLI loop
 * sequences them locally, and in M2 they become Step Functions task handlers.
 */
import type { Forge } from "@vocab/factory-forge";
import type { Db, WorkItemRow } from "@vocab/factory-ledger";

/** The states a work item moves through in M1. */
export type WorkItemState = "intake" | "proposal" | "awaiting-proposal-approval" | "escalated";

export interface HandlerContext {
  db: Db;
  forge: Forge;
}

/**
 * A handler's result.
 * - `advance`: the work item is now in `workItem.state`, ready for the next handler. A handler
 *   that ran a role passes the role's validated result along as `result`.
 * - `reject`: the input was not acceptable, nothing was created, and the run ends unsuccessfully.
 * - `escalate`: the work item is now `escalated` and waits for the owner; the run ends unsuccessfully.
 */
export type Transition =
  | { kind: "advance"; workItem: WorkItemRow; result?: unknown }
  | { kind: "reject"; reason: string }
  | { kind: "escalate"; workItem: WorkItemRow; reason: string };
