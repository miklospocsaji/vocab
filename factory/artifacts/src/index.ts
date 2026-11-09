import type { z } from "zod";
import { GatesResult } from "./gates-result.ts";
import { ProposalResult } from "./proposal-result.ts";

export { CAPABILITIES, ProposalResult } from "./proposal-result.ts";
export { GATE_CHECKS, GatesResult } from "./gates-result.ts";
export type { GateCheck } from "./gates-result.ts";

/** Result schemas by the id a role config names in `resultSchema`. */
export const resultSchemas: Readonly<Record<string, z.ZodType>> = {
  "proposal-result": ProposalResult,
  "gates-result": GatesResult,
};
