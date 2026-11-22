import type { VocabImport } from "../../../contracts/src/index.ts";

export type BookWordCount = { id: string | null; title: string | null; wordCount: number };

export const countWordsPerBook = (_vocabImport: VocabImport): BookWordCount[] => {
  throw new Error("not implemented");
};
