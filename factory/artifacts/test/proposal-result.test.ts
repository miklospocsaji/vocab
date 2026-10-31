import { describe, expect, it } from "vitest";
import { CAPABILITIES, ProposalResult, resultSchemas } from "../src/index.ts";

const valid = {
  changeId: "add-vocab-import",
  capabilities: ["vocab-import"],
  complexity: "medium",
  summary: "Import lookups from a Kindle vocab.db.",
  openQuestions: ["Should re-imports skip deleted books?"],
};

function without(key: keyof typeof valid): Record<string, unknown> {
  return Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
}

describe("ProposalResult", () => {
  // Control: without it, a schema that rejects everything would pass every test below.
  it("accepts a complete result, with or without open questions", () => {
    expect(ProposalResult.parse(valid)).toEqual(valid);
    expect(ProposalResult.safeParse({ ...valid, openQuestions: [] }).success).toBe(true);
  });

  it("is registered as proposal-result", () => {
    expect(resultSchemas["proposal-result"]).toBe(ProposalResult);
  });

  it("requires the change id, capabilities, complexity, summary and open questions", () => {
    for (const key of ["changeId", "capabilities", "complexity", "summary", "openQuestions"] as const) {
      expect(ProposalResult.safeParse(without(key)).success, key).toBe(false);
    }
  });

  it("refuses a change id that is not verb-led kebab-case", () => {
    for (const changeId of ["", "Add-Vocab", "vocab", "add_vocab_import", "add-vocab-"]) {
      expect(ProposalResult.safeParse({ ...valid, changeId }).success, changeId).toBe(false);
    }
  });

  it("limits capabilities to the eight in ADR 0004", () => {
    expect([...CAPABILITIES].sort()).toEqual(
      ["auth", "enrichment", "gates", "orchestration", "practice", "roles", "trajectories", "vocab-import"],
    );
    expect(ProposalResult.safeParse({ ...valid, capabilities: [...CAPABILITIES] }).success).toBe(true);
    expect(ProposalResult.safeParse({ ...valid, capabilities: ["billing"] }).success).toBe(false);
    expect(ProposalResult.safeParse({ ...valid, capabilities: [] }).success).toBe(false);
  });

  it("limits complexity to small, medium and large", () => {
    for (const complexity of ["small", "medium", "large"]) {
      expect(ProposalResult.safeParse({ ...valid, complexity }).success, complexity).toBe(true);
    }
    expect(ProposalResult.safeParse({ ...valid, complexity: "huge" }).success).toBe(false);
  });

  it("refuses unknown fields", () => {
    expect(ProposalResult.safeParse({ ...valid, design: "…" }).success).toBe(false);
  });
});
