import type { VocabImport } from "../../../contracts/src/index.ts";

export interface LanguageCount {
  language: string | null;
  count: number;
}

export function countLanguages(_vocab: VocabImport): LanguageCount[] {
  throw new Error("not implemented");
}
