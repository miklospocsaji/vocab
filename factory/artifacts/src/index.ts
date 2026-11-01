import type { z } from "zod";
import { ProposalResult } from "./proposal-result.ts";

export { CAPABILITIES, ProposalResult } from "./proposal-result.ts";

/** Result schemas by the id a role config names in `resultSchema`. */
export const resultSchemas: Readonly<Record<string, z.ZodType>> = {
  "proposal-result": ProposalResult,
};
