import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { VocabImport } from "../../contracts/src/index.ts";
import { parseVocabDb } from "../src/vocab-import/parse.ts";
import { reimportVocab } from "../src/vocab-import/reimport.ts";

const fixtures = resolve(import.meta.dirname, "../../fixtures");
const newer = (): VocabImport => parseVocabDb(resolve(fixtures, "vocab.db"));
const older = (): VocabImport => parseVocabDb(resolve(fixtures, "vocab-older.db"));

const cmp = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describe("reimportVocab", () => {
  it("Scenario: Newer file adds only new lookups", () => {
    const old = older();
    const result = reimportVocab(old, newer());
    expect(result.lookups).toHaveLength(183);
    const oldIds = new Set(old.lookups.map((l) => l.id));
    expect(result.lookups.some((l) => oldIds.has(l.id))).toBe(false);
  });

  it("Scenario: Re-importing the same file adds nothing", () => {
    const result = reimportVocab(newer(), newer());
    expect(result).toEqual({ books: [], words: [], lookups: [] });
  });

  it("Scenario: Only unknown words and books are returned", () => {
    const existing: VocabImport = {
      books: [{ id: "B1", title: "T", authors: "A", language: "en" }],
      words: [{ id: "en:known", word: "known", stem: "known", language: "en" }],
      lookups: [{ id: "L1", wordId: "en:known", bookId: "B1", usage: "u", timestamp: 1 }],
    };
    const next: VocabImport = {
      books: existing.books,
      words: [...existing.words, { id: "en:fresh", word: "fresh", stem: "fresh", language: "en" }],
      lookups: [
        ...existing.lookups,
        { id: "L2", wordId: "en:known", bookId: "B1", usage: "u2", timestamp: 2 },
        { id: "L3", wordId: "en:fresh", bookId: "B1", usage: "u3", timestamp: 3 },
      ],
    };
    const result = reimportVocab(existing, next);
    expect(result.lookups.map((l) => l.id)).toEqual(["L2", "L3"]);
    expect(result.words.map((w) => w.id)).toEqual(["en:fresh"]);
    expect(result.books).toEqual([]);
  });

  it("Scenario: Older plus new equals newer", () => {
    const old = older();
    const added = reimportVocab(old, newer());
    const direct = newer();
    expect({
      books: [...old.books, ...added.books].sort(cmp),
      words: [...old.words, ...added.words].sort(cmp),
      lookups: [...old.lookups, ...added.lookups].sort(cmp),
    }).toEqual(direct);
  });
});
