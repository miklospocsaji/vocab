// Data read from a Kindle `system/vocabulary/vocab.db` (capability `vocab-import`).
// Fields are copied as stored: a text column that is NULL in the file is `null` here.
import { z } from "zod";

/** A row of `BOOK_INFO`. `authors` is one string, as stored. */
export const VocabBookSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  authors: z.string().nullable(),
  language: z.string().nullable(),
});
export type VocabBook = z.infer<typeof VocabBookSchema>;

/** A row of `WORDS`. `id` looks like `en:abhors`; `stem` is the lemma (`abhor`). */
export const VocabWordSchema = z.object({
  id: z.string(),
  word: z.string().nullable(),
  stem: z.string().nullable(),
  language: z.string().nullable(),
});
export type VocabWord = z.infer<typeof VocabWordSchema>;

/**
 * A row of `LOOKUPS`. `wordId` and `bookId` always resolve to a word and a book
 * of the same parse. `usage` is the sentence as stored, never cleaned.
 * `timestamp` is epoch milliseconds as stored.
 */
export const VocabLookupSchema = z.object({
  id: z.string(),
  wordId: z.string(),
  bookId: z.string(),
  usage: z.string().nullable(),
  timestamp: z.number().int().nullable(),
});
export type VocabLookup = z.infer<typeof VocabLookupSchema>;

/**
 * The result of parsing a vocab.db, and the result of a re-import (only the new rows).
 * Each list is sorted by id in ascending UTF-16 code-unit order (JavaScript `<` on strings).
 */
export const VocabImportSchema = z.object({
  books: z.array(VocabBookSchema),
  words: z.array(VocabWordSchema),
  lookups: z.array(VocabLookupSchema),
});
export type VocabImport = z.infer<typeof VocabImportSchema>;

/**
 * Reads the vocab.db at `path` read-only. Throws an Error when the file is not a SQLite
 * database, when `WORDS`, `LOOKUPS` or `BOOK_INFO` is missing (naming the table), or when
 * a lookup's word or book is missing (naming the lookup id).
 */
export type ParseVocabDb = (path: string) => VocabImport;

/**
 * Returns the lookups of `parsed` whose id is not in `imported`, and the words and books
 * those lookups reference whose id is not in `imported`. Compares by id only.
 */
export type ReimportVocab = (imported: VocabImport, parsed: VocabImport) => VocabImport;
