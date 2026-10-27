import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allText, readRows } from "./helpers/kindle-db.ts";

const fixtures = ["vocab.db", "vocab-older.db"].map((f) => fileURLToPath(new URL(`../${f}`, import.meta.url)));

const placeholderOrEmpty = (v: unknown): boolean => v === null || v === "" || (typeof v === "string" && v.startsWith("fixture-"));

describe.each(fixtures)("committed fixture %s", (path) => {
  it("Scenario: Committed fixtures pass the identifier scan", () => {
    for (const b of readRows(path, "BOOK_INFO")) {
      expect([b["id"], b["guid"], b["asin"]].every(placeholderOrEmpty)).toBe(true);
    }
    for (const d of readRows(path, "DICT_INFO")) {
      expect([d["id"], d["asin"]].every(placeholderOrEmpty)).toBe(true);
    }
    const lookups = readRows(path, "LOOKUPS");
    expect(lookups.length).toBeGreaterThan(0);
    for (const l of lookups) {
      expect([l["book_key"], l["dict_key"]].every(placeholderOrEmpty)).toBe(true);
      expect(String(l["id"]).startsWith(`${String(l["book_key"])}:`)).toBe(true);
    }
    expect(allText(path).filter((v) => v.startsWith("CR!"))).toEqual([]);
    for (const r of [...readRows(path, "WORDS"), ...readRows(path, "METADATA")]) {
      expect([null, "", "fixture-profile"]).toContain(r["profileid"]);
    }
  });
});

describe("original vocab.db", () => {
  it("Scenario: Original file is ignored", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const out = execFileSync("git", ["check-ignore", "docs/vocab.db"], { cwd: repoRoot, encoding: "utf8" });
    expect(out.trim()).toBe("docs/vocab.db");
  });
});
