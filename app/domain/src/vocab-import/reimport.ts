import type { ReimportVocab } from "../../../contracts/src/index.ts";

const compareIds = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const reimportVocab: ReimportVocab = (existing, newer) => {
  const knownLookups = new Set(existing.lookups.map((l) => l.id));
  const knownWords = new Set(existing.words.map((w) => w.id));
  const knownBooks = new Set(existing.books.map((b) => b.id));
  const lookups = newer.lookups.filter((l) => !knownLookups.has(l.id));
  const wordRefs = new Set(lookups.map((l) => l.wordId));
  const bookRefs = new Set(lookups.map((l) => l.bookId));
  const words = newer.words.filter((w) => wordRefs.has(w.id) && !knownWords.has(w.id));
  const books = newer.books.filter((b) => bookRefs.has(b.id) && !knownBooks.has(b.id));
  return {
    books: books.sort(compareIds),
    words: words.sort(compareIds),
    lookups: lookups.sort(compareIds),
  };
};
