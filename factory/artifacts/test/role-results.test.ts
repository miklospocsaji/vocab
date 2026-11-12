import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BuildOutcome,
  ClassificationResult,
  DesignResult,
  ImplementationResult,
  PlanResult,
  resultSchemas,
  ReviewResult,
  TestResult,
} from "../src/index.ts";

const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PREFIX = "work-items/add-vocab-import/tasks/1.1/implementer/1";

const valid = {
  design: { summary: "Parse vocab.db into domain types.", contracts: ["app/contracts/src/import.ts"], adrNeeded: [], openQuestions: [] },
  review: { verdict: "approve", findings: [{ severity: "minor", location: "design.md#Data model", summary: "Name the table." }] },
  plan: {
    tasks: [
      {
        id: "1.1",
        title: "Parse the WORDS table",
        dependsOn: [],
        files: ["app/domain/src/import.ts"],
        scenarios: ["Import reads every word"],
        tests: ["app/domain/test/import.test.ts"],
      },
    ],
  },
  test: { tests: [{ file: "app/domain/test/import.test.ts", scenario: "Import reads every word" }], stubs: ["app/domain/src/import.ts"], notes: "" },
  implementation: { summary: "Implemented the parser.", notes: "" },
  classification: { kind: "bug", evidence: "The unit check failed on an assertion in the task's own test." },
  outcome: {
    role: "implementer",
    outcome: "passed",
    roleResult: { summary: "Implemented the parser.", notes: "" },
    diffCheck: { passed: true, outside: [] },
    gates: `${PREFIX}/gates.json`,
    patch: `${PREFIX}/patch.diff`,
    messages: `${PREFIX}/messages.jsonl`,
    baseCommit: BASE_COMMIT,
  },
};

describe("role result schemas", () => {
  // Control: without it, schemas that reject everything would pass the rejections below.
  it("accept a valid result each", () => {
    expect(DesignResult.parse(valid.design)).toEqual(valid.design);
    expect(ReviewResult.parse(valid.review)).toEqual(valid.review);
    expect(PlanResult.parse(valid.plan)).toEqual(valid.plan);
    expect(TestResult.parse(valid.test)).toEqual(valid.test);
    expect(ImplementationResult.parse(valid.implementation)).toEqual(valid.implementation);
    expect(ClassificationResult.parse(valid.classification)).toEqual(valid.classification);
    expect(BuildOutcome.parse(valid.outcome)).toEqual(valid.outcome);
  });

  it("are registered under the ids role configs name", () => {
    expect(resultSchemas).toMatchObject({
      "design-result": DesignResult,
      "review-result": ReviewResult,
      "plan-result": PlanResult,
      "test-result": TestResult,
      "implementation-result": ImplementationResult,
      "classification-result": ClassificationResult,
    });
    // build-outcome is the build container's output, not a role's result.
    expect(resultSchemas["build-outcome"]).toBeUndefined();
  });

  it("convert to draft-07 JSON Schema for structured output", () => {
    for (const [id, schema] of Object.entries(resultSchemas)) {
      expect(() => z.toJSONSchema(schema, { target: "draft-07" }), id).not.toThrow();
    }
  });

  it("reject unknown keys", () => {
    expect(DesignResult.safeParse({ ...valid.design, extra: 1 }).success).toBe(false);
    expect(ClassificationResult.safeParse({ ...valid.classification, confidence: 0.9 }).success).toBe(false);
  });
});

describe("ReviewResult", () => {
  const finding = (severity: string) => ({ severity, location: "design.md", summary: "Something." });

  it("accepts changes-requested with a blocker or major finding", () => {
    for (const severity of ["blocker", "major"]) {
      expect(ReviewResult.safeParse({ verdict: "changes-requested", findings: [finding("minor"), finding(severity)] }).success, severity).toBe(true);
    }
  });

  it("rejects changes-requested with only minor findings, or none", () => {
    expect(ReviewResult.safeParse({ verdict: "changes-requested", findings: [finding("minor"), finding("minor")] }).success).toBe(false);
    expect(ReviewResult.safeParse({ verdict: "changes-requested", findings: [] }).success).toBe(false);
  });

  it("rejects an unknown verdict or severity", () => {
    expect(ReviewResult.safeParse({ verdict: "reject", findings: [] }).success).toBe(false);
    expect(ReviewResult.safeParse({ verdict: "approve", findings: [finding("critical")] }).success).toBe(false);
  });
});

describe("PlanResult", () => {
  it("rejects an empty plan or a task without an id", () => {
    expect(PlanResult.safeParse({ tasks: [] }).success).toBe(false);
    const [task] = valid.plan.tasks;
    expect(PlanResult.safeParse({ tasks: [{ ...task, id: "" }] }).success).toBe(false);
    expect(PlanResult.safeParse({ tasks: [{ ...task, id: "first" }] }).success).toBe(false);
  });
});

describe("ClassificationResult", () => {
  it("accepts each of the five kinds and nothing else", () => {
    for (const kind of ["flaky", "bug", "design-flaw", "spec-ambiguity", "infra"]) {
      expect(ClassificationResult.safeParse({ kind, evidence: "x" }).success, kind).toBe(true);
    }
    expect(ClassificationResult.safeParse({ kind: "unknown", evidence: "x" }).success).toBe(false);
    expect(ClassificationResult.safeParse({ kind: "bug", evidence: "" }).success).toBe(false);
  });
});

describe("BuildOutcome", () => {
  const failed = (overrides: Record<string, unknown>) => ({ ...valid.outcome, outcome: "failed", ...overrides });

  it("accepts a failed outcome with a reason, with or without gates", () => {
    const outside = ["app/domain/test/import.test.ts"];
    expect(BuildOutcome.safeParse(failed({ reason: "diff-check", diffCheck: { passed: false, outside }, gates: undefined })).success).toBe(true);
    expect(BuildOutcome.safeParse(failed({ reason: "green" })).success).toBe(true);
    expect(BuildOutcome.safeParse(failed({ reason: "budget", roleResult: undefined, gates: undefined })).success).toBe(true);
  });

  it("requires a reason when failed, and none when passed", () => {
    expect(BuildOutcome.safeParse(failed({})).success).toBe(false);
    expect(BuildOutcome.safeParse({ ...valid.outcome, reason: "green" }).success).toBe(false);
  });

  it("rejects an unknown reason", () => {
    expect(BuildOutcome.safeParse(failed({ reason: "tired" })).success).toBe(false);
  });

  it("rejects a passed outcome whose diff check failed or that has no gates", () => {
    expect(BuildOutcome.safeParse({ ...valid.outcome, diffCheck: { passed: false, outside: ["x"] } }).success).toBe(false);
    expect(BuildOutcome.safeParse({ ...valid.outcome, gates: undefined }).success).toBe(false);
  });

  it("rejects a diff check whose verdict disagrees with its paths", () => {
    expect(BuildOutcome.safeParse(failed({ reason: "diff-check", diffCheck: { passed: false, outside: [] } })).success).toBe(false);
    expect(BuildOutcome.safeParse(failed({ reason: "green", diffCheck: { passed: true, outside: ["x"] } })).success).toBe(false);
  });

  it("rejects a base commit that is not a full SHA", () => {
    expect(BuildOutcome.safeParse({ ...valid.outcome, baseCommit: "HEAD" }).success).toBe(false);
    expect(BuildOutcome.safeParse({ ...valid.outcome, baseCommit: BASE_COMMIT.slice(0, 7) }).success).toBe(false);
  });
});
