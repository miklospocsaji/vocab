import { z } from "zod";

/** The eight capabilities of ADR 0004. */
export const CAPABILITIES = [
  "vocab-import",
  "trajectories",
  "enrichment",
  "practice",
  "auth",
  "orchestration",
  "roles",
  "gates",
] as const;

/** The proposal author's result (add-role-runner design.md). */
export const ProposalResult = z.strictObject({
  changeId: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/, "a verb-led kebab-case id"),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1),
  complexity: z.enum(["small", "medium", "large"]),
  summary: z.string().min(1),
  openQuestions: z.array(z.string()),
});

export type ProposalResult = z.infer<typeof ProposalResult>;
