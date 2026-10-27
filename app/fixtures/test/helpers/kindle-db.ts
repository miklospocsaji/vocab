import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// DDL copied from a real Kindle vocab.db.
export const KINDLE_DDL = [
  "CREATE TABLE WORDS (id TEXT PRIMARY KEY NOT NULL, word TEXT, stem TEXT, lang TEXT, category INTEGER DEFAULT 0, timestamp INTEGER DEFAULT 0, profileid TEXT)",
  "CREATE INDEX wordprofileid ON WORDS (profileid)",
  "CREATE TABLE LOOKUPS (id TEXT PRIMARY KEY NOT NULL, word_key TEXT, book_key TEXT, dict_key TEXT, pos TEXT, usage TEXT, timestamp INTEGER DEFAULT 0)",
  "CREATE INDEX lookupwordkey ON LOOKUPS (word_key)",
  "CREATE INDEX lookupbookkey ON LOOKUPS (book_key)",
  "CREATE TABLE BOOK_INFO (id TEXT PRIMARY KEY NOT NULL, asin TEXT, guid TEXT, lang TEXT, title TEXT, authors TEXT)",
  "CREATE TABLE DICT_INFO (id TEXT PRIMARY KEY NOT NULL, asin TEXT, langin TEXT, langout TEXT)",
  "CREATE TABLE METADATA (id TEXT PRIMARY KEY NOT NULL, dsname TEXT, sscnt INTEGER, profileid TEXT)",
  "CREATE TABLE VERSION (id TEXT PRIMARY KEY NOT NULL, dsname TEXT, value INTEGER)",
];

export interface SyntheticBook {
  id: string;
  asin: string;
  title: string;
  authors: string;
}

export const BOOKS: SyntheticBook[] = [
  { id: "CR!AAAA1111BBBB2222CCCC3333DDDD", asin: "B00SECRET1", title: "First Book", authors: "Author, One" },
  { id: "CR!EEEE4444FFFF5555GGGG6666HHHH:1a2b3c4d", asin: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", title: "Second Book", authors: "Author, Two" },
  { id: "Sideloaded_Title_Here:9z8y7x6w", asin: "12ab34cd-56ef-78ab-90cd-ef1234567890", title: "Third Book", authors: "Author, Three" },
  { id: "CR!IIII7777JJJJ8888KKKK9999LLLL", asin: "B00SECRET4", title: "Fourth Book", authors: "Author, Four" },
  { id: "CR!MMMM0000NNNN1111OOOO2222PPPP", asin: "B00SECRET5", title: "Fifth Book", authors: "Author, Five" },
];

export const DICT_ASIN = "B0053VMNY2";
export const PROFILE_ID = "PROFILE-SECRET-42";
export const BASE_TS = 1_694_554_155_744;

interface Lookup {
  book: number;
  word: string;
  pos: string;
  usage: string;
  at: number;
}

// Two lookups per book; "serendipity" is looked up in books 0 and 1, so one word spans books.
export const LOOKUPS: Lookup[] = BOOKS.flatMap((_, b) => [
  { book: b, word: b < 2 ? "serendipity" : `word${String(b)}a`, pos: String(1000 + b), usage: `Sentence one of book ${String(b)}.`, at: BASE_TS + b * 1_000_000 },
  { book: b, word: `word${String(b)}b`, pos: String(2000 + b), usage: `Sentence two of book ${String(b)}.`, at: BASE_TS + b * 1_000_000 + 90_000 },
]);

/** Builds a Kindle-shaped vocab.db with fake identifiers at `path`. */
export function createKindleDb(path: string): void {
  const db = new DatabaseSync(path);
  for (const ddl of KINDLE_DDL) db.exec(ddl);
  const insert = (sql: string, ...values: SQLInputValue[]) => db.prepare(sql).run(...values);
  for (const book of BOOKS) {
    insert("INSERT INTO BOOK_INFO VALUES (?, ?, ?, 'en', ?, ?)", book.id, book.asin, book.id, book.title, book.authors);
  }
  const firstSeen = new Map<string, number>();
  LOOKUPS.forEach((l, n) => {
    const book = BOOKS[l.book];
    if (!book) throw new Error(`no book ${String(l.book)}`);
    insert("INSERT INTO LOOKUPS VALUES (?, ?, ?, '', ?, ?, ?)", `${book.id}:${l.pos}:${String(n)}`, `en:${l.word}`, book.id, l.pos, l.usage, l.at);
    if (!firstSeen.has(l.word)) firstSeen.set(l.word, l.at);
  });
  for (const [word, at] of firstSeen) {
    insert("INSERT INTO WORDS VALUES (?, ?, ?, 'en', 0, ?, ?)", `en:${word}`, word, word, at, PROFILE_ID);
  }
  insert("INSERT INTO DICT_INFO VALUES (?, ?, 'en', 'en')", DICT_ASIN, DICT_ASIN);
  insert("INSERT INTO DICT_INFO VALUES ('', '', 'en', 'hu')");
  for (const name of ["WORDS", "LOOKUPS", "DICT_INFO", "BOOK_INFO"]) {
    insert("INSERT INTO METADATA VALUES (?, ?, 0, ?)", name, name, PROFILE_ID);
  }
  for (const name of ["WORDS", "LOOKUPS", "DICT_INFO", "BOOK_INFO", "METADATA"]) {
    insert("INSERT INTO VERSION VALUES (?, ?, 1)", name, name);
  }
  db.close();
}

export type Row = Record<string, unknown>;

export function readRows(path: string, table: string): Row[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all();
  } finally {
    db.close();
  }
}

export function readSchema(path: string): Row[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  } finally {
    db.close();
  }
}

export const TABLES = ["WORDS", "LOOKUPS", "BOOK_INFO", "DICT_INFO", "METADATA", "VERSION"] as const;

/** A logical dump: schema plus every row of every table, in a stable order. */
export function dump(path: string): string {
  return JSON.stringify({ schema: readSchema(path), rows: Object.fromEntries(TABLES.map((t) => [t, readRows(path, t)])) });
}

/** Every text value in every table. */
export function allText(path: string): string[] {
  return TABLES.flatMap((t) => readRows(path, t).flatMap((r) => Object.values(r).filter((v): v is string => typeof v === "string")));
}
