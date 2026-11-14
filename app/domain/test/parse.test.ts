import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVocabDb } from "../src/vocab-import/parse.ts";

const fixtures = resolve(import.meta.dirname, "../../fixtures");
const dir = mkdtempSync(join(tmpdir(), "vocab-parse-"));
let n = 0;

interface Spec {
  words?: [string, string, string, string][];
  books?: [string, string, string, string][];
  lookups?: [string, string, string, string, number][];
  skip?: string;
}

function build(spec: Spec): string {
  const path = join(dir, `t${String(n++)}.db`);
  const db = new DatabaseSync(path);
  if (spec.skip !== "WORDS")
    db.exec("CREATE TABLE WORDS (id TEXT PRIMARY KEY, word TEXT, stem TEXT, lang TEXT, category INTEGER, timestamp INTEGER, profileid TEXT)");
  if (spec.skip !== "BOOK_INFO")
    db.exec("CREATE TABLE BOOK_INFO (id TEXT PRIMARY KEY, asin TEXT, guid TEXT, lang TEXT, title TEXT, authors TEXT)");
  if (spec.skip !== "LOOKUPS")
    db.exec("CREATE TABLE LOOKUPS (id TEXT PRIMARY KEY, word_key TEXT, book_key TEXT, dict_key TEXT, pos TEXT, usage TEXT, timestamp INTEGER)");
  for (const [id, word, stem, lang] of spec.words ?? [])
    db.prepare("INSERT INTO WORDS (id, word, stem, lang) VALUES (?, ?, ?, ?)").run(id, word, stem, lang);
  for (const [id, title, authors, lang] of spec.books ?? [])
    db.prepare("INSERT INTO BOOK_INFO (id, title, authors, lang) VALUES (?, ?, ?, ?)").run(id, title, authors, lang);
  for (const [id, w, b, usage, ts] of spec.lookups ?? [])
    db.prepare("INSERT INTO LOOKUPS (id, word_key, book_key, usage, timestamp) VALUES (?, ?, ?, ?, ?)").run(id, w, b, usage, ts);
  db.close();
  return path;
}

const word: [string, string, string, string] = ["en:abhors", "abhors", "abhor", "en"];
const book: [string, string, string, string] = ["B1", "Title", "Author", "en"];

function messageOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
}

describe("parseVocabDb", () => {
  it("Scenario: Full fixture parses to its known counts", () => {
    const r = parseVocabDb(join(fixtures, "vocab.db"));
    expect(r.books).toHaveLength(4);
    expect(r.words).toHaveLength(640);
    expect(r.lookups).toHaveLength(733);
    const w = new Set(r.words.map((x) => x.id));
    const b = new Set(r.books.map((x) => x.id));
    for (const l of r.lookups) {
      expect(w.has(l.wordId)).toBe(true);
      expect(b.has(l.bookId)).toBe(true);
    }
  });

  it("Scenario: Older fixture parses to its known lookup count", () => {
    expect(parseVocabDb(join(fixtures, "vocab-older.db")).lookups).toHaveLength(550);
  });

  it("Scenario: Fields are carried over as stored", () => {
    const usage = "He  abhors\tit — “really”.";
    const r = parseVocabDb(build({ words: [word], books: [book], lookups: [["L1", "en:abhors", "B1", usage, 1700000000123]] }));
    expect(r.words[0]).toEqual({ id: "en:abhors", word: "abhors", stem: "abhor", language: "en" });
    expect(r.lookups[0]?.usage).toBe(usage);
    expect(r.lookups[0]?.timestamp).toBe(1700000000123);
  });

  it("Scenario: Parsing leaves the file unchanged", () => {
    const path = join(fixtures, "vocab.db");
    const bytes = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    parseVocabDb(path);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  it("Scenario: Repeated lookups are all kept", () => {
    const r = parseVocabDb(
      build({
        words: [word],
        books: [book],
        lookups: [["L1", "en:abhors", "B1", "a", 1], ["L2", "en:abhors", "B1", "a", 2], ["L3", "en:abhors", "B1", "a", 3]],
      }),
    );
    expect(r.lookups.map((l) => l.id)).toEqual(["L1", "L2", "L3"]);
  });

  it("Scenario: Lookup with a missing word fails", () => {
    const p = build({ words: [word], books: [book], lookups: [["LOOK-X1", "en:nope", "B1", "a", 1]] });
    expect(messageOf(() => parseVocabDb(p))).toMatch(/LOOK-X1/);
  });

  it("Scenario: Lookup with a missing book fails", () => {
    const p = build({ words: [word], books: [book], lookups: [["LOOK-X2", "en:abhors", "NOBOOK", "a", 1]] });
    expect(messageOf(() => parseVocabDb(p))).toMatch(/LOOK-X2/);
  });

  it("Scenario: Non-SQLite file is rejected", () => {
    const p = join(dir, "plain.txt");
    writeFileSync(p, "this is just a plain text file, definitely not a database at all.\n".repeat(5));
    expect(messageOf(() => parseVocabDb(p))).toMatch(/not a SQLite database/);
  });

  it("Scenario: Missing table is rejected", () => {
    const p = build({ skip: "LOOKUPS", words: [word], books: [book] });
    expect(messageOf(() => parseVocabDb(p))).toMatch(/LOOKUPS/);
  });

  it("Scenario: Lists are sorted by id", () => {
    const p = build({
      words: [["en:b", "b", "b", "en"], ["en:a", "a", "a", "en"], ["en:c", "c", "c", "en"]],
      books: [["B3", "t", "a", "en"], ["B1", "t", "a", "en"], ["B2", "t", "a", "en"]],
      lookups: [["L3", "en:a", "B1", "u", 3], ["L1", "en:b", "B2", "u", 1], ["L2", "en:c", "B3", "u", 2]],
    });
    const r = parseVocabDb(p);
    expect(r.books.map((x) => x.id)).toEqual(["B1", "B2", "B3"]);
    expect(r.words.map((x) => x.id)).toEqual(["en:a", "en:b", "en:c"]);
    expect(r.lookups.map((x) => x.id)).toEqual(["L1", "L2", "L3"]);
    expect(parseVocabDb(p)).toEqual(r);
  });
});
