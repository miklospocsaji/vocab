import { describe, expect, it } from "vitest";
import { cleanUsage } from "../src/clean-usage.ts";

describe("cleanUsage", () => {
  it("Scenario: Whitespace runs collapse and ends are trimmed", () => {
    expect(cleanUsage("  The  cat\nsat. ")).toBe("The cat sat.");
  });
  it("Scenario: Soft hyphen is removed", () => {
    expect(cleanUsage("un­believable")).toBe("unbelievable");
  });
  it("Scenario: Zero-width characters and byte order marks are removed", () => {
    expect(cleanUsage("﻿a​b‌c‍d")).toBe("abcd");
  });
  it("Scenario: Non-breaking space becomes a space", () => {
    expect(cleanUsage("a b")).toBe("a b");
  });
  it("Scenario: Empty sentence stays empty", () => {
    expect(cleanUsage("")).toBe("");
  });
  it("Scenario: Case, punctuation and quotes are kept", () => {
    const s = "“Hello,” she said—'Yes!'";
    expect(cleanUsage(s)).toBe(s);
  });
});
