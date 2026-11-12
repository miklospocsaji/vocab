import { it } from "vitest";

// Stands in for the factory's ledger-backed tests, which the gates must never run.
it("needs the ledger", () => {
  throw new Error("factory tests need FACTORY_DATABASE_URL");
});
