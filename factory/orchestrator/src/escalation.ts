/** A handler's escalation: the comment first, then the state, so a crash in between repeats the comment rather than losing it. */
import { setWorkItemState, type WorkItemRow } from "@vocab/factory-ledger";
import type { HandlerContext, Transition } from "./handler.ts";

export async function escalateWith(ctx: HandlerContext, item: WorkItemRow, body: string, reason: string): Promise<Transition> {
  await ctx.forge.comment(item.issueNumber, body);
  return { kind: "escalate", workItem: await setWorkItemState(ctx.db, item.id, "escalated"), reason };
}
