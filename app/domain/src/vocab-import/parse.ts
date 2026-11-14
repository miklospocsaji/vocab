import { DatabaseSync } from "node:sqlite";
import type {
  ParseVocabDb,
  VocabBook,
  VocabLookup,
  VocabWord,
} from "../../../contracts/src/index.ts";
import { VocabImportError } from "./errors.ts";

type Row = Record<string, unknown>;

const compareIds = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function isNotADatabase(e: unknown): boolean {
  return (
    e instanceof Error &&
    ((e as { errcode?: number }).errcode === 26 ||
      /not a database/i.test(e.message))
  );
}

function rowName(table: string, row: Row, id: unknown): string {
  return typeof id === "string"
    ? `${table} row ${id}`
    : `${table} rowid ${String(row["rowid"])}`;
}

function text(table: string, row: Row, col: string, label: string): string | null {
  const v = row[col];
  if (v === null) return null;
  if (typeof v !== "string")
    throw new VocabImportError(
      "unexpected-type",
      `${label}: column ${col} of ${table} is not text`,
    );
  return v;
}

function key(table: string, row: Row, col: string, idLabel: unknown): string {
  const v = row[col];
  const label = rowName(table, row, idLabel);
  if (v === null || v === undefined)
    throw new VocabImportError("null-id", `${label}: column ${col} of ${table} is NULL`);
  if (typeof v !== "string")
    throw new VocabImportError(
      "unexpected-type",
      `${label}: column ${col} of ${table} is not text`,
    );
  return v;
}

export const parseVocabDb: ParseVocabDb = (path: string) => {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    if (isNotADatabase(e))
      throw new VocabImportError("not-sqlite", `${path} is not a SQLite database`);
    throw new VocabImportError(
      "cannot-open",
      `cannot open ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    let names: Set<string>;
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Row[];
      names = new Set(rows.map((r) => String(r["name"])));
    } catch (e) {
      if (isNotADatabase(e))
        throw new VocabImportError("not-sqlite", `${path} is not a SQLite database`);
      throw e;
    }
    const missing = ["WORDS", "LOOKUPS", "BOOK_INFO"].filter((t) => !names.has(t));
    if (missing.length > 0)
      throw new VocabImportError(
        "missing-table",
        `${path} has no ${missing.join(", ")} table`,
      );

    const books: VocabBook[] = (
      db.prepare("SELECT rowid, id, title, authors, lang FROM BOOK_INFO").all() as Row[]
    ).map((r) => {
      const id = key("BOOK_INFO", r, "id", r["id"]);
      const label = rowName("BOOK_INFO", r, id);
      return {
        id,
        title: text("BOOK_INFO", r, "title", label),
        authors: text("BOOK_INFO", r, "authors", label),
        language: text("BOOK_INFO", r, "lang", label),
      };
    });
    const words: VocabWord[] = (
      db.prepare("SELECT rowid, id, word, stem, lang FROM WORDS").all() as Row[]
    ).map((r) => {
      const id = key("WORDS", r, "id", r["id"]);
      const label = rowName("WORDS", r, id);
      return {
        id,
        word: text("WORDS", r, "word", label),
        stem: text("WORDS", r, "stem", label),
        language: text("WORDS", r, "lang", label),
      };
    });
    const lookups: VocabLookup[] = (
      db
        .prepare(
          "SELECT rowid, id, word_key, book_key, usage, timestamp FROM LOOKUPS",
        )
        .all() as Row[]
    ).map((r) => {
      const id = key("LOOKUPS", r, "id", r["id"]);
      const label = rowName("LOOKUPS", r, id);
      const wordId = key("LOOKUPS", r, "word_key", id);
      const bookId = key("LOOKUPS", r, "book_key", id);
      const ts = r["timestamp"];
      if (ts !== null && !(typeof ts === "number" && Number.isInteger(ts)))
        throw new VocabImportError(
          "unexpected-type",
          `${label}: column timestamp of LOOKUPS is not an integer`,
        );
      return {
        id,
        wordId,
        bookId,
        usage: text("LOOKUPS", r, "usage", label),
        timestamp: ts,
      };
    });

    lookups.sort(compareIds);
    const wordIds = new Set(words.map((w) => w.id));
    const bookIds = new Set(books.map((b) => b.id));
    for (const l of lookups) {
      if (!wordIds.has(l.wordId))
        throw new VocabImportError(
          "dangling-reference",
          `lookup ${l.id} references missing word ${l.wordId}`,
        );
      if (!bookIds.has(l.bookId))
        throw new VocabImportError(
          "dangling-reference",
          `lookup ${l.id} references missing book ${l.bookId}`,
        );
    }
    books.sort(compareIds);
    words.sort(compareIds);
    return { books, words, lookups };
  } finally {
    db.close();
  }
};
