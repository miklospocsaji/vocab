import { expect, it } from "vitest";
import { double } from "../src/double.ts";

it("doubles a number", () => {
  expect(double(2)).toBe(5);
});
