import type { z } from "zod";
import { GatesResult } from "./gates-result.ts";
import { ProposalResult } from "./proposal-result.ts";
import { ClassificationResult, DesignResult, ImplementationResult, PlanResult, ReviewResult, TestResult } from "./role-results.ts";

export { CAPABILITIES, ProposalResult } from "./proposal-result.ts";
export { GATE_CHECKS, GatesResult } from "./gates-result.ts";
export type { GateCheck } from "./gates-result.ts";
export {
  BUILD_FAILURE_REASONS,
  BuildOutcome,
  ClassificationResult,
  DesignResult,
  ImplementationResult,
  PlanResult,
  ReviewResult,
  TestResult,
} from "./role-results.ts";

/** Result schemas by the id a role config names in `resultSchema`. */
export const resultSchemas: Readonly<Record<string, z.ZodType>> = {
  "proposal-result": ProposalResult,
  "gates-result": GatesResult,
  "design-result": DesignResult,
  "review-result": ReviewResult,
  "plan-result": PlanResult,
  "test-result": TestResult,
  "implementation-result": ImplementationResult,
  "classification-result": ClassificationResult,
};
