import { describe, expect, it } from "vitest";
import { CHANGE_ID_MAX_LENGTH, CHANGE_ID_VERBS, deriveChangeId } from "../src/change-id.ts";

const nothingTaken = () => false;
const taken = (...ids: string[]) => (id: string) => ids.includes(id);

describe("deriveChangeId", () => {
  it("Scenario: Leading verb is kept", async () => {
    expect(await deriveChangeId("Fix duplicate lookups on re-import", nothingTaken)).toBe("fix-duplicate-lookups-on-re-import");
  });

  it("Scenario: Colliding id gets a suffix", async () => {
    expect(await deriveChangeId("Import Kindle vocab.db", taken("add-import-kindle-vocab-db"))).toBe("add-import-kindle-vocab-db-2");
  });

  it("prefixes `add` when the title does not start with a verb", async () => {
    expect(await deriveChangeId("Import Kindle vocab.db", nothingTaken)).toBe("add-import-kindle-vocab-db");
  });

  it.each(CHANGE_ID_VERBS)("keeps the leading verb %s, in any case", async (verb) => {
    expect(await deriveChangeId(`${verb.toUpperCase()} the importer`, nothingTaken)).toBe(`${verb}-the-importer`);
  });

  it("does not treat a word that merely starts with a verb as the verb", async () => {
    expect(await deriveChangeId("Fixing the importer", nothingTaken)).toBe("add-fixing-the-importer");
  });

  it("collapses punctuation and accents to single hyphens", async () => {
    expect(await deriveChangeId("Améliorer l'écran: «Révision» — rapide!!", nothingTaken)).toBe("add-ameliorer-l-ecran-revision-rapide");
    expect(await deriveChangeId("  --Remove   the  ÜBER_flag?? ", nothingTaken)).toBe("remove-the-uber-flag");
  });

  it("cuts an id longer than 40 characters at a word boundary", async () => {
    const id = await deriveChangeId("Improve the lookup table rendering for very long word lists", nothingTaken);
    expect(id).toBe("improve-the-lookup-table-rendering-for");
    expect(CHANGE_ID_MAX_LENGTH).toBe(40);
  });

  it("keeps an id of exactly 40 characters whole", async () => {
    const id = await deriveChangeId("Fix the lookup table rendering on mobile devices", nothingTaken);
    expect(id).toBe("fix-the-lookup-table-rendering-on-mobile");
    expect(id).toHaveLength(40);
  });

  it("cuts a single word longer than the limit at the limit", async () => {
    const id = await deriveChangeId("Add Pneumonoultramicroscopicsilicovolcanoconiosis support", nothingTaken);
    expect(id).toBe("add-pneumonoultramicroscopicsilicovolcan");
    expect(id).toHaveLength(40);
  });

  it("keeps the suffix within 40 characters by cutting the base shorter at a word boundary", async () => {
    const id = await deriveChangeId("Fix the lookup table rendering on mobile devices", taken("fix-the-lookup-table-rendering-on-mobile"));
    expect(id).toBe("fix-the-lookup-table-rendering-on-2");
  });

  it("counts the suffix up until an id is free, never offering one over 40 characters", async () => {
    const offered: string[] = [];
    const busy = new Set(["fix-the-lookup-table-rendering-on-mobile", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `fix-the-lookup-table-rendering-on-${String(n)}`)]);
    const id = await deriveChangeId("Fix the lookup table rendering on mobile devices", (candidate) => {
      offered.push(candidate);
      return busy.has(candidate);
    });

    expect(id).toBe("fix-the-lookup-table-rendering-on-10");
    expect(offered).toHaveLength(10);
    expect(offered.every((candidate) => candidate.length <= 40)).toBe(true);
  });

  it("accepts an asynchronous isTaken, such as a ledger or remote-branch lookup", async () => {
    const id = await deriveChangeId("Import Kindle vocab.db", (candidate) => Promise.resolve(candidate === "add-import-kindle-vocab-db"));
    expect(id).toBe("add-import-kindle-vocab-db-2");
  });
});
