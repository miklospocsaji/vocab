import { describe, expect, it } from "vitest";
import { databaseUrl } from "../src/env.ts";

describe("databaseUrl", () => {
  it("returns FACTORY_DATABASE_URL when it is set", () => {
    expect(databaseUrl({ FACTORY_DATABASE_URL: "postgres://h:1/db" })).toBe("postgres://h:1/db");
  });

  it("fails with instructions when FACTORY_DATABASE_URL is unset or empty", () => {
    for (const env of [{}, { FACTORY_DATABASE_URL: " " }]) {
      expect(() => databaseUrl(env)).toThrow(/FACTORY_DATABASE_URL is not set.*pnpm db:up/);
    }
  });
});
