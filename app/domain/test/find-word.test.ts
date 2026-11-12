import { describe, expect, it } from "vitest";
import { findWord } from "../src/find-word.ts";

describe("findWord", () => {
  it("Scenario: Match ignores case", () => {
    expect(findWord("The Cat sat.", "cat")).toEqual({ start: 4, end: 7 });
  });
  it("Scenario: Match inside a longer word is skipped", () => {
    expect(findWord("Concatenate the cat.", "cat")).toEqual({ start: 16, end: 19 });
  });
  it("Scenario: Accented word is matched with Unicode boundaries", () => {
    expect(findWord("Il était là.", "était")).toEqual({ start: 3, end: 8 });
  });
  it("Scenario: Accented letter next to the match blocks it", () => {
    expect(findWord("écat", "cat")).toBeUndefined();
  });
  it("Scenario: No match returns undefined", () => {
    expect(findWord("No match here.", "cat")).toBeUndefined();
  });
  it("Scenario: Blank word returns undefined", () => {
    expect(findWord("The cat sat.", "")).toBeUndefined();
    expect(findWord("The cat sat.", "   ")).toBeUndefined();
  });
});
