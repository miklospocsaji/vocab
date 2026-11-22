import type { VocabImport } from "../../../contracts/src/index.ts";

export type BookWordCount = { id: string | null; title: string | null; wordCount: number };

export const countWordsPerBook = (vocabImport: VocabImport): BookWordCount[] => {
  const titles = new Map<string, string | null>();
  for (const b of vocabImport.books) titles.set(b.id, b.title);
  const groups = new Map<string | null, Set<string>>();
  for (const l of vocabImport.lookups) {
    const key = titles.has(l.bookId) ? l.bookId : null;
    let set = groups.get(key);
    if (!set) {
      set = new Set();
      groups.set(key, set);
    }
    set.add(l.wordId);
  }
  const result: BookWordCount[] = [];
  for (const [id, set] of groups) {
    result.push({ id, title: id === null ? null : (titles.get(id) ?? null), wordCount: set.size });
  }
  return result.sort((a, b) => {
    if (a.wordCount !== b.wordCount) return b.wordCount - a.wordCount;
    if (a.id === b.id) return 0;
    if (a.id === null) return 1;
    if (b.id === null) return -1;
    return a.id < b.id ? -1 : 1;
  });
};
