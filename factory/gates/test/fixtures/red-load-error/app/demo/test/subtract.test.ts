import { describe, expect, it } from "vitest";
import { subtract } from "../src/minus.ts";

describe("subtract", () => {
  it("Scenario: Subtracts two numbers", () => {
    expect(subtract(3, 1)).toBe(2);
  });

  it("Scenario: Refuses non-finite numbers", () => {
    expect(() => subtract(1, Infinity)).toThrow(/finite/);
  });
});
