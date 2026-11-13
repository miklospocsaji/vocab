// Plain data read from a Kindle `vocab.db` (capability `vocab-import`).
// Fields are read as stored: a text column that is NULL in the file is `null` here.
import { z } from "zod";

/** A row of `BOOK_INFO`. `authors` is the stored string, not split. */
export const Book = z.object({
  id: z.string(),
  title: z.string().nullable(),
  authors: z.string().nullable(),
  language: z.string().nullable(),
});
export type Book = z.infer<typeof Book>;

/** A row of `WORDS`. `id` looks like `en:abhors`; `stem` is the lemma. */
export const Word = z.object({
  id: z.string(),
  word: z.string().nullable(),
  stem: z.string().nullable(),
  language: z.string().nullable(),
});
export type Word = z.infer<typeof Word>;

/** A row of `LOOKUPS`. `wordId` is a `Word.id`, `bookId` a `Book.id`. */
export const Lookup = z.object({
  id: z.string(),
  wordId: z.string(),
  bookId: z.string(),
  /** The usage sentence exactly as stored. */
  usage: z.string().nullable(),
  /** Epoch milliseconds, as stored. */
  timestamp: z.number().int(),
});
export type Lookup = z.infer<typeof Lookup>;

/** Everything imported from one or more `vocab.db` files. Each list is sorted by id, ascending. */
export const ImportedVocab = z.object({
  books: z.array(Book),
  words: z.array(Word),
  lookups: z.array(Lookup),
});
export type ImportedVocab = z.infer<typeof ImportedVocab>;

/**
 * Reads the `vocab.db` at `path`, read-only, into sorted plain data.
 * Throws when the file is not SQLite, lacks `WORDS`, `LOOKUPS` or `BOOK_INFO`,
 * or holds a lookup whose word or book is missing (the error names the lookup id).
 */
export type ParseVocabDb = (path: string) => ImportedVocab;

/**
 * Returns the lookups of `newer` whose id is not in `imported`, and the words and
 * books those lookups reference that are not in `imported`, each sorted by id.
 * Compares by id only.
 */
export type Reimport = (imported: ImportedVocab, newer: ImportedVocab) => ImportedVocab;
