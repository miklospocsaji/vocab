import { it } from "vitest";

function stub(): number {
  throw new Error("not implemented");
}

it("throws inside the test", () => {
  stub();
});
