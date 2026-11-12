/**
 * The design-flaw path (add-build-loop spec, "Design flaws send the change back to Design"): a
 * build attempt the failure classifier labelled `design-flaw` sends the work item back to Design.
 * Design and Plan find that attempt in the ledger, so a retried task re-derives it: Design puts its
 * evidence in the architect's first prompt, and both count their attempts from it.
 */
import { listAttempts, type AttemptRow, type Db } from "@vocab/factory-ledger";
import type { RetryEvidence } from "@vocab/factory-roles";
import { fence } from "./evidence.ts";

export interface DesignFlaw {
  /** The failed build attempt the classifier labelled. */
  attempt: AttemptRow;
  /** For the architect's first attempt after the flaw. */
  evidence: RetryEvidence;
}

/** A classification as the ledger stores it; anything else reads as none. */
export function classificationOf(attempt: AttemptRow): { kind: string; evidence: string } | undefined {
  const value = attempt.classification as { kind?: unknown; evidence?: unknown } | null;
  if (typeof value !== "object" || value === null || typeof value.kind !== "string") return undefined;
  return { kind: value.kind, evidence: typeof value.evidence === "string" ? value.evidence : "" };
}

/** The failed checks of a stored gates result, each with its output, fenced; "" when none failed. */
export function failedChecks(gates: unknown): string {
  const checks = (gates as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return "";
  return (checks as { name?: unknown; passed?: unknown; exitCode?: unknown; output?: unknown }[])
    .filter((check) => check.passed === false)
    .map((check) => {
      const exit = typeof check.exitCode === "number" ? ` (exit ${String(check.exitCode)})` : "";
      const output = typeof check.output === "string" && check.output !== "" ? `\n\n${fence(check.output)}` : "";
      return `Check \`${String(check.name)}\` failed${exit}.${output}`;
    })
    .join("\n\n");
}

/**
 * The work item's design flaw that has not been planned for yet: the latest build attempt
 * labelled `design-flaw`, if no plan succeeded after it.
 */
export async function pendingDesignFlaw(db: Db, workItemId: string): Promise<DesignFlaw | undefined> {
  const attempts = await listAttempts(db, workItemId);
  const flawed = attempts.filter((attempt) => classificationOf(attempt)?.kind === "design-flaw").at(-1);
  if (flawed === undefined) return undefined;
  if (attempts.some((attempt) => attempt.state === "plan" && attempt.outcome === "succeeded" && BigInt(attempt.id) > BigInt(flawed.id))) return undefined;
  const checks = failedChecks(flawed.gates);
  const evidence = [
    `Task ${flawed.taskId ?? "?"} failed its green gates, and the failure classifier found a flaw in the design:`,
    classificationOf(flawed)?.evidence ?? "",
    ...(checks === "" ? [] : ["The failed checks:", checks]),
    "Revise the design so the task can be built.",
  ].join("\n\n");
  return { attempt: flawed, evidence: { reason: "design-flaw", evidence } };
}

/** The id of the latest design-flaw attempt, or 0: Design and Plan count their attempts after it. */
export async function lastDesignFlawId(db: Db, workItemId: string): Promise<bigint> {
  const flawed = (await listAttempts(db, workItemId)).filter((attempt) => classificationOf(attempt)?.kind === "design-flaw").at(-1);
  return flawed === undefined ? 0n : BigInt(flawed.id);
}
