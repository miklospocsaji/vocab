import { z } from "zod";

// Plain data read from a Kindle `vocab.db` (change add-read-a-kindle-vocab-db-into-books).
// Fields are carried over as stored: a NULL text column is `null`, an empty string stays "".
// Ids are never null: a NULL id is an import error.

/** A row of `BOOK_INFO`. */
export const VocabBook = z.strictObject({
  /** `BOOK_INFO.id` */
  id: z.string(),
  /** `BOOK_INFO.title` */
  title: z.string().nullable(),
  /** `BOOK_INFO.authors` */
  authors: z.string().nullable(),
  /** `BOOK_INFO.lang` */
  language: z.string().nullable(),
});
export type VocabBook = z.infer<typeof VocabBook>;

/** A row of `WORDS`. */
export const VocabWord = z.strictObject({
  /** `WORDS.id`, such as `en:abhors` */
  id: z.string(),
  /** `WORDS.word` */
  word: z.string().nullable(),
  /** `WORDS.stem`, the lemma */
  stem: z.string().nullable(),
  /** `WORDS.lang` */
  language: z.string().nullable(),
});
export type VocabWord = z.infer<typeof VocabWord>;

/** A row of `LOOKUPS`. */
export const VocabLookup = z.strictObject({
  /** `LOOKUPS.id` */
  id: z.string(),
  /** `LOOKUPS.word_key`, a `VocabWord.id` */
  wordId: z.string(),
  /** `LOOKUPS.book_key`, a `VocabBook.id` */
  bookId: z.string(),
  /** `LOOKUPS.usage`, the sentence exactly as stored */
  usage: z.string().nullable(),
  /** `LOOKUPS.timestamp`, epoch milliseconds as stored */
  timestamp: z.number().int().nullable(),
});
export type VocabLookup = z.infer<typeof VocabLookup>;

/**
 * The books, words and lookups of one import, each list sorted by id in ascending
 * UTF-16 code-unit order (`a < b`). Also the shape re-import returns: only the new data.
 */
export const VocabImport = z.strictObject({
  books: z.array(VocabBook),
  words: z.array(VocabWord),
  lookups: z.array(VocabLookup),
});
export type VocabImport = z.infer<typeof VocabImport>;

/** Why an import failed; carried on the error the importer throws. */
export const VocabImportErrorCode = z.enum([
  "cannot-open",
  "not-sqlite",
  "missing-table",
  "null-id",
  "unexpected-type",
  "dangling-reference",
]);
export type VocabImportErrorCode = z.infer<typeof VocabImportErrorCode>;

/** Reads the `vocab.db` at `path`, read-only, into plain data. Throws on any invalid input. */
export type ParseVocabDb = (path: string) => VocabImport;

/**
 * Returns only what `newer` adds to `existing`: the lookups whose id is not in `existing`,
 * and the words and books those lookups reference that are not in `existing`. Compares by id
 * only; neither input is modified.
 */
export type ReimportVocab = (existing: VocabImport, newer: VocabImport) => VocabImport;
