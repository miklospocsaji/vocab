import { z } from "zod";

/** The checks a gates run can report (add-build-gates design.md). */
export const GATE_CHECKS = ["typecheck", "lint", "unit", "spec", "coverage", "red"] as const;

/** The most a check's output may hold: 16 KB, counted in UTF-8 bytes. */
const OUTPUT_BYTES = 16 * 1024;

const GateTest = z.strictObject({
  file: z.string(),
  name: z.string(),
  problem: z.enum(["passed", "failed", "load-error", "missing"]),
});

const GateCheck = z.strictObject({
  name: z.enum(GATE_CHECKS),
  passed: z.boolean(),
  /** null for checks that run in process (coverage, red). */
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  output: z
    .string()
    .refine((output) => new TextEncoder().encode(output).length <= OUTPUT_BYTES, "at most 16 KB")
    .optional(),
  /** coverage and red: the scenario titles no test names. */
  missing: z.array(z.string()).optional(),
  tests: z.array(GateTest).optional(),
});

/** `gates.json`: the result of the red or green gates for one task of a change. */
export const GatesResult = z.strictObject({
  mode: z.enum(["red", "green"]),
  changeId: z.string().min(1),
  taskId: z.string().min(1),
  passed: z.boolean(),
  checks: z.array(GateCheck),
});

export type GatesResult = z.infer<typeof GatesResult>;
export type GateCheck = z.infer<typeof GateCheck>;
