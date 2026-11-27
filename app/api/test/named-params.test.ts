import { describe, expect, it } from "vitest";
import { toPositional } from "../src/db/pglite.ts";

describe("toPositional", () => {
  it("Scenario: Named parameters become positional", () => {
    expect(toPositional("SELECT :a, :b", { a: 1, b: "x" })).toEqual({ sql: "SELECT $1, $2", values: [1, "x"] });
  });

  it("Scenario: A repeated name reuses its position", () => {
    expect(toPositional("SELECT :a + :b + :a", { a: 1, b: 2 })).toEqual({
      sql: "SELECT $1 + $2 + $1",
      values: [1, 2],
    });
  });

  it("Scenario: A cast is left alone", () => {
    expect(toPositional("SELECT :n::int, now()::date", { n: "5" })).toEqual({
      sql: "SELECT $1::int, now()::date",
      values: ["5"],
    });
  });

  it("Scenario: Names inside single-quoted strings are left alone", () => {
    expect(toPositional("SELECT ':a', 'it''s :b', :a", { a: 1 })).toEqual({
      sql: "SELECT ':a', 'it''s :b', $1",
      values: [1],
    });
  });

  it("Scenario: Names inside line comments are left alone", () => {
    expect(toPositional("SELECT 1 -- :a here\n, :b", { b: true })).toEqual({
      sql: "SELECT 1 -- :a here\n, $1",
      values: [true],
    });
  });

  it("Scenario: Names inside double-quoted identifiers are left alone", () => {
    expect(toPositional('SELECT 1 AS ":a", :b', { b: null })).toEqual({ sql: 'SELECT 1 AS ":a", $1', values: [null] });
  });

  it("Scenario: An unknown name is rejected", () => {
    expect(() => toPositional("SELECT :missing", { a: 1 })).toThrow(/missing/);
  });

  it("Scenario: SQL without parameters is unchanged", () => {
    expect(toPositional("SELECT 1", undefined)).toEqual({ sql: "SELECT 1", values: [] });
  });
});
