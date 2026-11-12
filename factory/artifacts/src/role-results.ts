/**
 * The results of M3's session roles, and the build container's outcome (add-build-roles
 * design.md). Every role result is strict, so a key the role invents fails the attempt.
 */
import { z } from "zod";

const text = z.string().min(1);

/** The architect's result. */
export const DesignResult = z.strictObject({
  summary: text,
  /** The contract files under `app/contracts/src/` it changed. */
  contracts: z.array(text),
  /** The decisions that need an ADR. */
  adrNeeded: z.array(text),
  openQuestions: z.array(text),
});
export type DesignResult = z.infer<typeof DesignResult>;

const Finding = z.strictObject({
  severity: z.enum(["blocker", "major", "minor"]),
  location: text,
  summary: text,
});

/** The design reviewer's result (`review.json`): `changes-requested` needs a blocker or major finding. */
export const ReviewResult = z
  .strictObject({
    verdict: z.enum(["approve", "changes-requested"]),
    findings: z.array(Finding),
  })
  .refine((review) => review.verdict === "approve" || review.findings.some((finding) => finding.severity !== "minor"), {
    message: "changes-requested needs at least one blocker or major finding",
    path: ["findings"],
  });
export type ReviewResult = z.infer<typeof ReviewResult>;

/** A task id as `tasks.md` numbers it: `1.1`, `2.13`. */
const TaskId = z.string().regex(/^\d+(\.\d+)+$/, "a numbered task id such as 1.1");

const PlanTask = z.strictObject({
  id: TaskId,
  title: text,
  /** Ids of earlier tasks of the plan. */
  dependsOn: z.array(TaskId),
  /** The source files the implementer writes, worktree-relative. */
  files: z.array(text),
  /** The exact scenario titles this task makes pass. */
  scenarios: z.array(text),
  /** The test files the test author writes, worktree-relative. */
  tests: z.array(text),
});

/** The planner's result (`tasks.json`); `validatePlan` checks it against the change. */
export const PlanResult = z.strictObject({ tasks: z.array(PlanTask).min(1) });
export type PlanResult = z.infer<typeof PlanResult>;

/** The test author's result. */
export const TestResult = z.strictObject({
  tests: z.array(z.strictObject({ file: text, scenario: text })),
  /** The new source files it stubbed. */
  stubs: z.array(text),
  notes: z.string(),
});
export type TestResult = z.infer<typeof TestResult>;

/** The implementer's result. */
export const ImplementationResult = z.strictObject({
  summary: text,
  notes: z.string(),
});
export type ImplementationResult = z.infer<typeof ImplementationResult>;

/** The failure classifier's result. */
export const ClassificationResult = z.strictObject({
  kind: z.enum(["flaky", "bug", "design-flaw", "spec-ambiguity", "infra"]),
  evidence: text,
});
export type ClassificationResult = z.infer<typeof ClassificationResult>;

/** Why a build attempt failed: a runner failure reason, the diff check, or a gate. */
export const BUILD_FAILURE_REASONS = [
  "max-turns",
  "budget",
  "error",
  "no-result",
  "invalid-result",
  "invalid-change",
  "auth-mode-mismatch",
  "config",
  "diff-check",
  "red",
  "green",
] as const;

/**
 * `outcome.json`: what one build container run did. `gates`, `patch` and `messages` are
 * artifact store keys. A passed outcome has a passed diff check, gates and no reason; a failed
 * one has a reason.
 */
export const BuildOutcome = z
  .strictObject({
    role: text,
    outcome: z.enum(["passed", "failed"]),
    reason: z.enum(BUILD_FAILURE_REASONS).optional(),
    roleResult: z.unknown().optional(),
    diffCheck: z
      .strictObject({ passed: z.boolean(), outside: z.array(text) })
      .refine((check) => check.passed === (check.outside.length === 0), "passed exactly when no path is outside"),
    gates: text.optional(),
    patch: text,
    messages: text,
    /** The commit the session started from, given in the input, never read from the clone. */
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/, "a full commit SHA"),
  })
  .superRefine((outcome, ctx) => {
    if (outcome.outcome === "failed") {
      if (outcome.reason === undefined) ctx.addIssue({ code: "custom", path: ["reason"], message: "a failed outcome needs a reason" });
      return;
    }
    if (outcome.reason !== undefined) ctx.addIssue({ code: "custom", path: ["reason"], message: "a passed outcome has no reason" });
    if (!outcome.diffCheck.passed) ctx.addIssue({ code: "custom", path: ["diffCheck"], message: "a passed outcome needs a passed diff check" });
    if (outcome.gates === undefined) ctx.addIssue({ code: "custom", path: ["gates"], message: "a passed outcome needs its gates result" });
  });
export type BuildOutcome = z.infer<typeof BuildOutcome>;
