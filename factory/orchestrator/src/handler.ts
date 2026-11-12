/**
 * What every state handler shares. Handlers are plain async functions `(ctx, item) =>
 * Promise<Transition>` with no AWS-specific control flow (ADR 0002): the M1 CLI loop
 * sequences them locally, and in M2 they become Step Functions task handlers.
 */
import type { Forge } from "@vocab/factory-forge";
import type { Db, WorkItemRow } from "@vocab/factory-ledger";

/**
 * The states a work item moves through. After `proposal-approved`, a `small` change goes to
 * `plan`, and the others through `design` (with `design-review` for `medium`, or
 * `awaiting-design-approval` for `large`) first.
 */
export type WorkItemState =
  | "intake"
  | "proposal"
  | "awaiting-proposal-approval"
  | "proposal-approved"
  | "design"
  | "design-review"
  | "awaiting-design-approval"
  | "plan"
  | "build"
  | "pr-open"
  | "escalated";

/**
 * Where an advancing handler sends the work item next, when it has a choice:
 * - `design`: to Design (Approved, for a `medium` or `large` change)
 * - `plan`: to Plan (Approved for a `small` change, or Design once the reviewer approved)
 * - `owner-review`: Design for a `large` change, to the owner's design approval
 */
export type Route = "design" | "plan" | "owner-review";

export interface HandlerContext {
  db: Db;
  forge: Forge;
}

/**
 * A handler's result.
 * - `advance`: the work item is now in `workItem.state`, ready for the next handler. A handler
 *   that ran a role passes the role's validated result along as `result`. `route` says where it
 *   goes next when there is a choice; Plan gives the unfinished task ids, in order, as `tasks`.
 * - `reject`: the input was not acceptable, nothing was created, and the run ends unsuccessfully.
 * - `escalate`: the work item is now `escalated` and waits for the owner; the run ends unsuccessfully.
 * - `duplicate`: the issue's work item belongs to another execution (in the cloud only). Nothing
 *   changed, and this execution ends.
 */
export type Transition =
  | { kind: "advance"; workItem: WorkItemRow; result?: unknown; route?: Route; tasks?: string[] }
  | { kind: "reject"; reason: string }
  | { kind: "escalate"; workItem: WorkItemRow; reason: string }
  | { kind: "duplicate"; workItem: WorkItemRow };
