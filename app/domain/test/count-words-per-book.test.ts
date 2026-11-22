import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { VocabImport } from "../../contracts/src/index.ts";
import * as domain from "../src/index.ts";
import type { countWordsPerBook as CountFn } from "../src/vocab-import/count-words-per-book.ts";

// Read through the entry point (loose type: index.ts does not export it yet).
const entry = domain as unknown as { countWordsPerBook: typeof CountFn; parseVocabDb: (path: string) => VocabImport };
const countWordsPerBook: typeof CountFn = (i) => entry.countWordsPerBook(i);
const parseVocabDb = entry.parseVocabDb;

const book = (id: string, title: string | null = null) => ({ id, title, authors: null, language: null });
const word = (id: string) => ({ id, word: null, stem: null, language: null });
let n = 0;
const lookup = (wordId: string, bookId: string) => ({
  id: `L${String(++n)}`,
  wordId,
  bookId,
  usage: null,
  timestamp: null,
});
const imp = (books: string[], words: string[], lookups: ReturnType<typeof lookup>[]): VocabImport => ({
  books: books.map((b) => book(b)),
  words: words.map(word),
  lookups,
});

describe("countWordsPerBook", () => {
  it("Scenario: Each book with lookups gets one entry", () => {
    const i: VocabImport = {
      books: [book("B1", "One"), book("B2", null)],
      words: [word("w1"), word("w2")],
      lookups: [lookup("w1", "B1"), lookup("w2", "B1"), lookup("w1", "B2")],
    };
    const r = countWordsPerBook(i);
    expect(r).toHaveLength(2);
    expect(r).toContainEqual({ id: "B1", title: "One", wordCount: 2 });
    expect(r).toContainEqual({ id: "B2", title: null, wordCount: 1 });
  });

  it("Scenario: Repeated lookups of one word count once", () => {
    const r = countWordsPerBook(imp(["B1"], ["w1"], [lookup("w1", "B1"), lookup("w1", "B1"), lookup("w1", "B1")]));
    expect(r).toEqual([{ id: "B1", title: null, wordCount: 1 }]);
  });

  it("Scenario: A word looked up in two books counts in each", () => {
    const r = countWordsPerBook(imp(["B1", "B2"], ["w1"], [lookup("w1", "B1"), lookup("w1", "B2")]));
    expect(r).toEqual([
      { id: "B1", title: null, wordCount: 1 },
      { id: "B2", title: null, wordCount: 1 },
    ]);
  });

  it("Scenario: Books without lookups are left out", () => {
    const r = countWordsPerBook(imp(["B1", "B2"], ["w1", "w2"], [lookup("w1", "B1"), lookup("w2", "B1")]));
    expect(r.map((e) => e.id)).toEqual(["B1"]);
  });

  it("Scenario: Input import is not modified", () => {
    const i = imp(["B1", "B2"], ["w1", "w2"], [lookup("w1", "B1"), lookup("w2", "X1")]);
    const copy = structuredClone(i);
    countWordsPerBook(i);
    expect(i).toEqual(copy);
  });

  it("Scenario: Unmatched lookups share one null entry", () => {
    const i = imp(["B1"], ["w1", "w2", "w3"], [lookup("w1", "B1"), lookup("w2", "X1"), lookup("w3", "X2")]);
    const r = countWordsPerBook(i);
    expect(r.filter((e) => e.id === null)).toEqual([{ id: null, title: null, wordCount: 2 }]);
    expect(r).toContainEqual({ id: "B1", title: null, wordCount: 1 });
    expect(r).toHaveLength(2);
  });

  it("Scenario: A word under two unknown books counts once", () => {
    const r = countWordsPerBook(imp([], ["w1"], [lookup("w1", "X1"), lookup("w1", "X2")]));
    expect(r).toEqual([{ id: null, title: null, wordCount: 1 }]);
  });

  it("Scenario: No lookups gives an empty list", () => {
    expect(countWordsPerBook(imp(["B1"], ["w1"], []))).toEqual([]);
  });

  it("Scenario: Higher counts come first", () => {
    const i = imp(
      ["B1", "B2"],
      ["w1", "w2", "w3"],
      [lookup("w1", "B1"), lookup("w1", "B2"), lookup("w2", "B2"), lookup("w3", "B2")],
    );
    expect(countWordsPerBook(i).map((e) => e.id)).toEqual(["B2", "B1"]);
  });

  it("Scenario: Many repeats of few words rank below many distinct words", () => {
    const i = imp(
      ["B1", "B2"],
      ["w1", "w2"],
      [...Array.from({ length: 5 }, () => lookup("w1", "B1")), lookup("w1", "B2"), lookup("w2", "B2")],
    );
    expect(countWordsPerBook(i).map((e) => [e.id, e.wordCount])).toEqual([
      ["B2", 2],
      ["B1", 1],
    ]);
  });

  it("Scenario: Ties are ordered by book id", () => {
    const i = imp(["B2", "B1"], ["w1", "w2"], [lookup("w1", "B2"), lookup("w1", "B1"), lookup("w2", "X9")]);
    expect(countWordsPerBook(i).map((e) => e.id)).toEqual(["B1", "B2", null]);
  });

  it("Scenario: Counts are usable through the domain entry point", () => {
    const parsed = parseVocabDb(resolve(import.meta.dirname, "../../fixtures/vocab.db"));
    const r = countWordsPerBook(parsed);
    const ids = new Set(parsed.books.map((b) => b.id));
    expect(r.length).toBeGreaterThan(0);
    for (const e of r) {
      expect(e.id).not.toBeNull();
      expect(ids.has(e.id as string)).toBe(true);
    }
    const counts = r.map((e) => e.wordCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});
