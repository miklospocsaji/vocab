/**
 * Turns a Kindle vocab.db into an anonymised fixture (ADR 0005).
 *
 * Keeps the schema and the real words, sentences, titles and authors of the selected books.
 * Replaces book ids, GUIDs, ASINs, dictionary ids and profile ids with placeholders, and shifts
 * every timestamp so the earliest one is FIXTURE_EPOCH_MS.
 *
 *   node app/fixtures/scripts/anonymise-vocab-db.ts --in docs/vocab.db --out app/fixtures/vocab.db \
 *     --older-out app/fixtures/vocab-older.db --book "<title>" [--book "<title>" ...] [--older-fraction 0.75]
 */
import { rmSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { parseArgs } from "node:util";

export const FIXTURE_EPOCH_MS = 1_577_836_800_000; // 2020-01-01T00:00:00Z
const DEFAULT_OLDER_FRACTION = 0.75;
const KNOWN_TABLES = ["WORDS", "LOOKUPS", "BOOK_INFO", "DICT_INFO", "METADATA", "VERSION"];
const PROFILE_PLACEHOLDER = "fixture-profile";

export interface AnonymiseOptions {
  input: string;
  output: string;
  olderOutput?: string;
  /** Exact titles of the books to keep. */
  books: string[];
  /** Share of lookups, by time, that go into the older snapshot. */
  olderFraction?: number;
}

type Row = Record<string, SQLOutputValue>;
/** A column read from a Row; undefined when the column is absent. */
type Value = SQLOutputValue | undefined;

interface Snapshot {
  WORDS: Row[];
  LOOKUPS: Row[];
  BOOK_INFO: Row[];
  DICT_INFO: Row[];
  METADATA: Row[];
  VERSION: Row[];
}

const str = (v: Value): string => (typeof v === "string" ? v : "");

/** Maps each distinct non-empty original value to `fixture-<kind>-NN`, in first-seen order. */
class Placeholders {
  private readonly map = new Map<string, string>();
  private readonly kind: string;

  constructor(kind: string) {
    this.kind = kind;
  }

  get(value: Value): SQLOutputValue {
    if (typeof value !== "string" || value === "") return value ?? null;
    let placeholder = this.map.get(value);
    if (placeholder === undefined) {
      placeholder = `fixture-${this.kind}-${String(this.map.size + 1).padStart(2, "0")}`;
      this.map.set(value, placeholder);
    }
    return placeholder;
  }
}

const profile = (v: Value): SQLOutputValue => (typeof v === "string" && v !== "" ? PROFILE_PLACEHOLDER : (v ?? null));

export function anonymise(options: AnonymiseOptions): void {
  const src = new DatabaseSync(options.input, { readOnly: true });
  try {
    const ddl = src.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all();
    const unknown = ddl.filter((d) => d["type"] === "table" && !KNOWN_TABLES.includes(str(d["name"])));
    if (unknown.length > 0) {
      throw new Error(`Unknown tables in input, refusing to guess what they hold: ${unknown.map((d) => str(d["name"])).join(", ")}`);
    }
    const all = (sql: string, ...params: SQLInputValue[]): Row[] => src.prepare(sql).all(...params);

    const books: Row[] = [];
    for (const title of options.books) {
      const matches = all("SELECT * FROM BOOK_INFO WHERE title = ? ORDER BY id", title);
      if (matches.length === 0) throw new Error(`No book titled "${title}"`);
      books.push(...matches);
    }
    books.sort((a, b) => str(a["title"]).localeCompare(str(b["title"])) || str(a["id"]).localeCompare(str(b["id"])));

    const bookIds = new Placeholders("book"); // book ids and GUIDs share one map; GUIDs usually equal ids
    const asins = new Placeholders("asin");
    const dictIds = new Placeholders("dict");
    for (const b of books) bookIds.get(b["id"]);

    const keptBookIds = books.map((b) => str(b["id"]));
    const lookups = all(
      `SELECT * FROM LOOKUPS WHERE book_key IN (${keptBookIds.map(() => "?").join(", ")}) ORDER BY timestamp, id`,
      ...keptBookIds,
    );
    const wordIds = [...new Set(lookups.map((l) => str(l["word_key"])))];
    const words = wordIds.length === 0 ? [] : all(`SELECT * FROM WORDS WHERE id IN (${wordIds.map(() => "?").join(", ")})`, ...wordIds);
    const dicts = all("SELECT * FROM DICT_INFO ORDER BY id");

    const stamps = [...lookups, ...words].map((r) => Number(r["timestamp"]));
    const offset = stamps.length === 0 ? 0 : FIXTURE_EPOCH_MS - Math.min(...stamps);
    const shift = (v: Value): SQLOutputValue => (typeof v === "number" || typeof v === "bigint" ? Number(v) + offset : (v ?? null));

    const lookupId = (l: Row): string => {
      const id = str(l["id"]);
      const bookKey = str(l["book_key"]);
      if (!id.startsWith(`${bookKey}:`)) throw new Error("Lookup id does not start with its book key; unknown format");
      return `${str(bookIds.get(bookKey))}${id.slice(bookKey.length)}`;
    };

    const full: Snapshot = {
      BOOK_INFO: books.map((b) => ({ ...b, id: bookIds.get(b["id"]), guid: bookIds.get(b["guid"]), asin: asins.get(b["asin"]) })),
      DICT_INFO: dicts.map((d) => ({ ...d, id: dictIds.get(d["id"]), asin: dictIds.get(d["asin"]) })),
      LOOKUPS: lookups.map((l) => ({
        ...l,
        id: lookupId(l),
        book_key: bookIds.get(l["book_key"]),
        dict_key: dictIds.get(l["dict_key"]),
        timestamp: shift(l["timestamp"]),
      })),
      WORDS: words.map((w) => ({ ...w, timestamp: shift(w["timestamp"]), profileid: profile(w["profileid"]) })),
      METADATA: all("SELECT * FROM METADATA").map((m) => ({ ...m, profileid: profile(m["profileid"]) })),
      VERSION: all("SELECT * FROM VERSION"),
    };

    write(options.output, ddl, full);
    if (options.olderOutput !== undefined) {
      write(options.olderOutput, ddl, olderSnapshot(full, options.olderFraction ?? DEFAULT_OLDER_FRACTION));
    }
  } finally {
    src.close();
  }
}

/** Lookups up to the timestamp at the given rank, plus the words and books they reference. */
function olderSnapshot(full: Snapshot, fraction: number): Snapshot {
  if (!(fraction > 0 && fraction < 1)) throw new Error(`--older-fraction must be between 0 and 1, got ${String(fraction)}`);
  const sorted = [...full.LOOKUPS].sort((a, b) => Number(a["timestamp"]) - Number(b["timestamp"]));
  const cutoffRow = sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  if (cutoffRow === undefined) throw new Error("No lookups to cut an older snapshot from");
  const cutoff = Number(cutoffRow["timestamp"]);
  const LOOKUPS = full.LOOKUPS.filter((l) => Number(l["timestamp"]) <= cutoff);
  if (LOOKUPS.length === full.LOOKUPS.length) throw new Error("Older snapshot would contain every lookup; lower --older-fraction");
  const words = new Set(LOOKUPS.map((l) => l["word_key"]));
  const books = new Set(LOOKUPS.map((l) => l["book_key"]));
  return {
    ...full,
    LOOKUPS,
    WORDS: full.WORDS.filter((w) => words.has(w["id"])),
    BOOK_INFO: full.BOOK_INFO.filter((b) => books.has(b["id"])),
  };
}

function write(path: string, ddl: Row[], snapshot: Snapshot): void {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    for (const d of ddl) db.exec(str(d["sql"]));
    db.exec("BEGIN");
    for (const [table, rows] of Object.entries(snapshot) as [string, Row[]][]) {
      const sorted = [...rows].sort((a, b) => str(a["id"]).localeCompare(str(b["id"])));
      for (const row of sorted) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
          ...cols.map((c) => row[c] ?? null),
        );
      }
    }
    db.exec("COMMIT");
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      in: { type: "string" },
      out: { type: "string" },
      "older-out": { type: "string" },
      book: { type: "string", multiple: true },
      "older-fraction": { type: "string" },
    },
  });
  if (values.in === undefined || values.out === undefined || values.book === undefined) {
    console.error('Usage: anonymise-vocab-db.ts --in <vocab.db> --out <fixture.db> [--older-out <older.db>] --book "<title>"... [--older-fraction 0.75]');
    process.exit(2);
  }
  anonymise({
    input: values.in,
    output: values.out,
    books: values.book,
    ...(values["older-out"] === undefined ? {} : { olderOutput: values["older-out"] }),
    ...(values["older-fraction"] === undefined ? {} : { olderFraction: Number(values["older-fraction"]) }),
  });
}
