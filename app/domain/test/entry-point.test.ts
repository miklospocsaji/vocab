import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { VocabImport } from "../../contracts/src/index.ts";
import * as domain from "../src/index.ts";

// The namespace is read through a loose type so this file loads and type-checks
// before the entry point exports the importer.
const entry = domain as unknown as {
  parseVocabDb: (path: string) => VocabImport;
  reimportVocab: (existing: VocabImport, newer: VocabImport) => VocabImport;
  VocabImportError: unknown;
};

describe("domain entry point", () => {
  it("Scenario: Importer is usable through the package entry points", () => {
    const path = resolve(import.meta.dirname, "../../fixtures/vocab.db");
    const parsed: VocabImport = entry.parseVocabDb(path);
    expect(parsed.books).toHaveLength(4);
    expect(parsed.words).toHaveLength(640);
    expect(parsed.lookups).toHaveLength(733);
    expect(entry.reimportVocab(parsed, parsed).lookups).toHaveLength(0);
    expect(typeof entry.VocabImportError).toBe("function");
  });
});
