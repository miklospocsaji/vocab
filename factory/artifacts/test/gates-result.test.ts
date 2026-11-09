import { describe, expect, it } from "vitest";
import { GatesResult, resultSchemas } from "../src/index.ts";

const check = (name: string) => ({ name, passed: true, exitCode: 0, durationMs: 120 });

const valid = {
  mode: "green",
  changeId: "add-vocab-import",
  taskId: "1.2",
  passed: true,
  checks: [
    check("typecheck"),
    check("lint"),
    { ...check("unit"), output: "Test Files  3 passed (3)\n", tests: [] },
    check("spec"),
    { name: "coverage", passed: true, exitCode: null, durationMs: 3, missing: [] },
    {
      name: "red",
      passed: false,
      exitCode: null,
      durationMs: 1,
      missing: ["Re-import adds only new lookups"],
      tests: [
        { file: "app/domain/test/import.test.ts", name: "import Scenario: Import reads every book", problem: "passed" },
        { file: "app/domain/test/other.test.ts", name: "", problem: "load-error" },
      ],
    },
  ],
};

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

describe("GatesResult", () => {
  // Control: without it, a schema that rejects everything would pass the rejections below.
  it("accepts a result with every check", () => {
    expect(GatesResult.parse(valid)).toEqual(valid);
    expect(GatesResult.safeParse({ ...valid, mode: "red", passed: false }).success).toBe(true);
  });

  it("is registered as gates-result", () => {
    expect(resultSchemas["gates-result"]).toBe(GatesResult);
  });

  it("rejects an unknown check name", () => {
    const checks = [...valid.checks, check("e2e")];
    expect(GatesResult.safeParse({ ...valid, checks }).success).toBe(false);
  });

  it("rejects an output over 16 KB", () => {
    const at = (output: string) => ({ ...valid, checks: [{ ...check("unit"), output }] });
    expect(GatesResult.safeParse(at("x".repeat(16 * 1024))).success).toBe(true);
    expect(GatesResult.safeParse(at("x".repeat(16 * 1024 + 1))).success).toBe(false);
    // Bytes, not characters: 6000 three-byte characters are 18000 bytes.
    expect(GatesResult.safeParse(at("€".repeat(6000))).success).toBe(false);
  });

  it("rejects a missing passed, on the result or on a check", () => {
    expect(GatesResult.safeParse(without(valid, "passed")).success).toBe(false);
    expect(GatesResult.safeParse({ ...valid, checks: [without(check("lint"), "passed")] }).success).toBe(false);
  });

  it("rejects an unknown mode or test problem", () => {
    expect(GatesResult.safeParse({ ...valid, mode: "blue" }).success).toBe(false);
    const tests = [{ file: "a.test.ts", name: "x", problem: "slow" }];
    expect(GatesResult.safeParse({ ...valid, checks: [{ ...check("unit"), tests }] }).success).toBe(false);
  });
});
