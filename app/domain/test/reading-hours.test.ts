import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { VocabImport } from "../../contracts/src/index.ts";
import * as domain from "../src/index.ts";
import {
  lookupsPerHour,
  peakReadingHours,
  type LookupsPerHour,
} from "../src/vocab-import/reading-hours.ts";

const HOUR = 3_600_000;
const DAY0 = 1577836800000; // 2020-01-01T00:00:00.000Z

function imp(timestamps: (number | null)[]): VocabImport {
  return {
    books: [],
    words: [],
    lookups: timestamps.map((timestamp, i) => ({
      id: `l${String(i)}`,
      wordId: "w",
      bookId: "b",
      usage: null,
      timestamp,
    })),
  };
}

const at = (h: number, extra = 0): number => DAY0 + h * HOUR + extra;

function counts(c: Record<number, number>, undated = 0): LookupsPerHour {
  return {
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: c[hour] ?? 0 })),
    undated,
  };
}

describe("lookupsPerHour", () => {
  it("Scenario: All 24 hours are returned in order", () => {
    const r = lookupsPerHour(imp([at(9), at(9, 5), at(9, 999)]));
    expect(r.hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    for (const h of r.hours) expect(h.count).toBe(h.hour === 9 ? 3 : 0);
  });

  it("Scenario: Lookups are counted under the UTC hour they fall in", () => {
    const r = lookupsPerHour(imp([at(7), at(7, 1000), at(22)]));
    expect(r.hours[7]?.count).toBe(2);
    expect(r.hours[22]?.count).toBe(1);
    expect(r.hours.reduce((s, h) => s + h.count, 0)).toBe(3);
  });

  it("Scenario: The hour is taken from the timestamp in UTC", () => {
    const r = lookupsPerHour(
      imp([1577836800000, 1577863800000, 1577916000000, 1577923199999]),
    );
    for (const h of r.hours)
      expect(h.count).toBe([0, 7, 22, 23].includes(h.hour) ? 1 : 0);
  });

  it("Scenario: Repeated lookups each count", () => {
    const r = lookupsPerHour(imp([at(14), at(14, 1), at(14, 2)]));
    expect(r.hours[14]?.count).toBe(3);
  });

  it("Scenario: Null timestamps are counted as undated", () => {
    const r = lookupsPerHour(imp([at(8), at(8, 10), null]));
    expect(r.hours[8]?.count).toBe(2);
    expect(r.hours.reduce((s, h) => s + h.count, 0)).toBe(2);
    expect(r.undated).toBe(1);
  });

  it("Scenario: Empty import gives zero counts", () => {
    const r = lookupsPerHour(imp([]));
    expect(r.hours).toHaveLength(24);
    expect(r.hours.every((h) => h.count === 0)).toBe(true);
    expect(r.undated).toBe(0);
  });
});

describe("peakReadingHours", () => {
  it("Scenario: Single peak hour is returned", () => {
    expect(peakReadingHours(counts({ 21: 5, 3: 4, 10: 1 }))).toEqual([21]);
  });

  it("Scenario: Tied peak hours are all returned in order", () => {
    expect(peakReadingHours(counts({ 22: 4, 6: 4, 10: 3 }))).toEqual([6, 22]);
  });

  it("Scenario: No dated lookups gives no peak hours", () => {
    expect(peakReadingHours(counts({}))).toEqual([]);
    expect(peakReadingHours(counts({}, 3))).toEqual([]);
  });
});

describe("domain entry point", () => {
  it("Scenario: Reading-hour functions are usable through the domain entry point", () => {
    const entry = domain as unknown as {
      parseVocabDb: (path: string) => VocabImport;
      lookupsPerHour: (i: VocabImport) => LookupsPerHour;
      peakReadingHours: (r: LookupsPerHour) => number[];
    };
    const parsed = entry.parseVocabDb(resolve(import.meta.dirname, "../../fixtures/vocab.db"));
    const before = structuredClone(parsed);
    const r = entry.lookupsPerHour(parsed);
    expect(r.hours.reduce((s, h) => s + h.count, 0) + r.undated).toBe(733);
    const peaks = entry.peakReadingHours(r);
    expect(parsed).toEqual(before);
    expect(entry.lookupsPerHour(parsed)).toEqual(r);
    expect(entry.peakReadingHours(r)).toEqual(peaks);
  });
});
