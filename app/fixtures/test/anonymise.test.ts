import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonymise, FIXTURE_EPOCH_MS } from "../scripts/anonymise-vocab-db.ts";
import { allText, BOOKS, createKindleDb, DICT_ASIN, dump, LOOKUPS, PROFILE_ID, readRows, readSchema } from "./helpers/kindle-db.ts";

const dir = mkdtempSync(join(tmpdir(), "vocab-fixture-"));
const input = join(dir, "input.db");
const output = join(dir, "out.db");
const older = join(dir, "older.db");
const selected = ["First Book", "Second Book"];

function run(out: string, olderOut: string): void {
  anonymise({ input, output: out, olderOutput: olderOut, books: selected, olderFraction: 0.5 });
}

beforeAll(() => {
  createKindleDb(input);
  run(output, older);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("anonymise-vocab-db", () => {
  it("Scenario: Schema is unchanged", () => {
    expect(readSchema(output)).toEqual(readSchema(input));
  });

  it("Scenario: No original identifier survives", () => {
    const secrets = [...BOOKS.flatMap((b) => [b.id, b.asin]), DICT_ASIN, PROFILE_ID];
    const text = allText(output).concat(allText(older));
    for (const secret of secrets) {
      expect(text.filter((v) => v.includes(secret))).toEqual([]);
    }
  });

  it("Scenario: References still resolve", () => {
    const books = new Set(readRows(output, "BOOK_INFO").map((r) => r["id"]));
    const words = new Set(readRows(output, "WORDS").map((r) => r["id"]));
    const lookups = readRows(output, "LOOKUPS");
    expect(lookups.length).toBeGreaterThan(0);
    for (const l of lookups) {
      expect(books).toContain(l["book_key"]);
      expect(words).toContain(l["word_key"]);
    }
  });

  it("Scenario: Only selected books are kept", () => {
    const titles = readRows(output, "BOOK_INFO").map((r) => r["title"]);
    expect(titles.sort()).toEqual([...selected].sort());

    const expected = LOOKUPS.filter((l) => l.book < 2);
    expect(readRows(output, "LOOKUPS")).toHaveLength(expected.length);
    const expectedWords = [...new Set(expected.map((l) => `en:${l.word}`))].sort();
    expect(readRows(output, "WORDS").map((r) => r["id"])).toEqual(expectedWords);
  });

  it("Scenario: Sentences are kept verbatim", () => {
    const usages = readRows(output, "LOOKUPS").map((r) => r["usage"]);
    const expected = LOOKUPS.filter((l) => l.book < 2).map((l) => l.usage);
    expect(usages.sort()).toEqual(expected.sort());
    const words = readRows(output, "WORDS");
    expect(words.every((w) => w["word"] === w["stem"] && `en:${String(w["word"])}` === w["id"])).toBe(true);
  });

  it("Scenario: Earliest timestamp is the fixed epoch", () => {
    const stamps = [...readRows(output, "WORDS"), ...readRows(output, "LOOKUPS")].map((r) => Number(r["timestamp"]));
    expect(Math.min(...stamps)).toBe(FIXTURE_EPOCH_MS);
  });

  it("Scenario: Gaps are preserved", () => {
    const byUsage = new Map(readRows(output, "LOOKUPS").map((r) => [r["usage"], Number(r["timestamp"])]));
    const a = byUsage.get("Sentence one of book 0.");
    const b = byUsage.get("Sentence two of book 0.");
    expect(a).toBeDefined();
    expect(Number(b) - Number(a)).toBe(90_000);
  });

  it("Scenario: Older snapshot is a subset", () => {
    for (const table of ["WORDS", "LOOKUPS", "BOOK_INFO", "DICT_INFO", "METADATA", "VERSION"]) {
      const full = readRows(output, table).map((r) => JSON.stringify(r));
      for (const row of readRows(older, table)) {
        expect(full).toContain(JSON.stringify(row));
      }
    }
    expect(readRows(older, "LOOKUPS").length).toBeLessThan(readRows(output, "LOOKUPS").length);
    expect(readRows(older, "LOOKUPS").length).toBeGreaterThan(0);
  });

  it("Scenario: Two runs agree", () => {
    const again = join(dir, "again.db");
    const againOlder = join(dir, "again-older.db");
    run(again, againOlder);
    expect(dump(again)).toBe(dump(output));
    expect(dump(againOlder)).toBe(dump(older));
  });

  it("rejects a title that matches no book", () => {
    expect(() => {
      anonymise({ input, output: join(dir, "x.db"), books: ["No Such Book"] });
    }).toThrow(/No Such Book/);
  });
});
