import { it } from "vitest";
import { nothing } from "../src/nowhere.ts";

it("never runs", () => {
  nothing();
});
