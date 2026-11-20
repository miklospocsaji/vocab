import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { VocabImport } from "../../contracts/src/index.ts";
import * as domain from "../src/index.ts";
import { countLanguages } from "../src/vocab-import/count-languages.ts";
import { parseVocabDb } from "../src/vocab-import/parse.ts";

const fixture = (): VocabImport => parseVocabDb(resolve(import.meta.dirname, "../../fixtures/vocab.db"));

function make(words: [string, string | null][], lookups: string[]): VocabImport {
  return {
    books: [{ id: "B1", title: null, authors: null, language: null }],
    words: words.map(([id, language]) => ({ id, word: id, stem: null, language })),
    lookups: lookups.map((wordId, i) => ({ id: `L${String(i)}`, wordId, bookId: "B1", usage: null, timestamp: null })),
  };
}

describe("countLanguages", () => {
  it("Scenario: Lookups are counted under their word's language", () => {
    const imp = make([["a", "en"], ["b", "de"]], ["a", "a", "a", "b"]);
    const r = countLanguages(imp);
    expect(r).toHaveLength(2);
    expect(r).toContainEqual({ language: "en", count: 3 });
    expect(r).toContainEqual({ language: "de", count: 1 });
  });

  it("Scenario: Counts add up to the number of lookups", () => {
    const total = countLanguages(fixture()).reduce((s, e) => s + e.count, 0);
    expect(total).toBe(733);
  });

  it("Scenario: Import without lookups gives an empty list", () => {
    expect(countLanguages(make([["a", "en"]], []))).toEqual([]);
  });

  it("Scenario: Higher counts come first", () => {
    const imp = make([["a", "en"], ["b", "de"]], ["b", "a", "a"]);
    expect(countLanguages(imp)).toEqual([{ language: "en", count: 2 }, { language: "de", count: 1 }]);
  });

  it("Scenario: Ties are ordered by language ascending", () => {
    const imp = make([["a", "fr"], ["b", "de"]], ["a", "a", "b", "b"]);
    expect(countLanguages(imp)).toEqual([{ language: "de", count: 2 }, { language: "fr", count: 2 }]);
  });

  it("Scenario: Word with null language is counted under null", () => {
    const imp = make([["a", null], ["b", "en"]], ["a", "b"]);
    const r = countLanguages(imp);
    expect(r).toHaveLength(2);
    expect(r).toContainEqual({ language: null, count: 1 });
    expect(r).toContainEqual({ language: "en", count: 1 });
  });

  it("Scenario: Lookup of a missing word is counted under null", () => {
    const imp = make([["a", "en"]], ["ghost"]);
    let r: ReturnType<typeof countLanguages> = [];
    expect(() => {
      r = countLanguages(imp);
    }).not.toThrow();
    expect(r).toContainEqual({ language: null, count: 1 });
  });

  it("Scenario: Null-language and missing-word lookups share one entry", () => {
    const imp = make([["a", null]], ["a", "ghost"]);
    expect(countLanguages(imp)).toEqual([{ language: null, count: 2 }]);
  });

  it("Scenario: Counting leaves the import unchanged", () => {
    const imp = fixture();
    const copy = structuredClone(imp);
    const first = countLanguages(imp);
    const second = countLanguages(imp);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(imp).toEqual(copy);
  });

  it("Scenario: Counting is usable through the domain entry point", () => {
    const entry = domain as unknown as { countLanguages: (i: VocabImport) => { language: string | null; count: number }[] };
    const r = entry.countLanguages(fixture());
    expect(r.length).toBeGreaterThan(0);
  });
});
