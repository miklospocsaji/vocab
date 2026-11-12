import { describe, expect, it } from "vitest";
import { add } from "../src/add.ts";

describe("add", () => {
  it("Scenario: Adds two numbers", () => {
    expect(add(1, 2)).toBe(3);
  });
});
