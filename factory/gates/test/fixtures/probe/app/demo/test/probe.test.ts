import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

it("records its environment", () => {
  writeFileSync("env-unit.json", JSON.stringify(process.env));
  expect(process.env["PATH"]).toBeDefined();
});
