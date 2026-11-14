# Design

## Overview

`app/domain` gets two pure functions. `parseVocabDb(path)` opens the file read-only with Node 24's built-in `node:sqlite`, checks that it is SQLite and has `WORDS`, `LOOKUPS` and `BOOK_INFO`, reads the three tables, checks types, ids and references, and returns a `VocabImport` with each list sorted by id. `reimportVocab(existing, newer)` compares two `VocabImport`s by id and returns only what is new. The data types are zod schemas with inferred types in `app/contracts`, so storage, upload and practice can use and validate the same shapes. No dependencies are added.

## Components

### `app/contracts` (`src/vocab-import.ts`, re-exported from `src/index.ts`)

- `VocabBook { id: string; title, authors, language: string | null }` from `BOOK_INFO (id, title, authors, lang)`.
- `VocabWord { id: string; word, stem, language: string | null }` from `WORDS (id, word, stem, lang)`.
- `VocabLookup { id, wordId, bookId: string; usage: string | null; timestamp: number | null }` from `LOOKUPS (id, word_key, book_key, usage, timestamp)`.
- `VocabImport { books; words; lookups }`, each sorted by id. It is both the parse result and the re-import result.
- `VocabImportErrorCode`: `cannot-open | not-sqlite | missing-table | null-id | unexpected-type | dangling-reference`.
- Function types `ParseVocabDb = (path: string) => VocabImport` and `ReimportVocab = (existing: VocabImport, newer: VocabImport) => VocabImport`, which the domain functions implement.

### `app/domain`

`package.json` gains the workspace dependency `@vocab/contracts` (`workspace:*`). Nothing else is added.

`src/vocab-import/errors.ts`
- `class VocabImportError extends Error` with a readonly `code: VocabImportErrorCode` field, assigned in the constructor body (no parameter properties). The message is always readable on its own and names what the spec requires: the lookup id, the missing table, the table and row.

`src/vocab-import/parse.ts`, `parseVocabDb: ParseVocabDb`
1. Open `new DatabaseSync(path, { readOnly: true })`. An open failure throws `cannot-open` naming the path. Close the database in `finally`.
2. Run `SELECT name FROM sqlite_master WHERE type = 'table'`. A SQLite "file is not a database" error (`errcode` 26, `SQLITE_NOTADB`) throws `not-sqlite` with the message "`<path>` is not a SQLite database". Any of `WORDS`, `LOOKUPS`, `BOOK_INFO` that is missing (exact name) throws `missing-table`, naming every missing table, such as "`<path>` has no LOOKUPS table".
3. Read only the needed columns, including `rowid`: `SELECT rowid, id, title, authors, lang FROM BOOK_INFO`, `SELECT rowid, id, word, stem, lang FROM WORDS`, and `SELECT rowid, id, word_key, book_key, usage, timestamp FROM LOOKUPS`. `DICT_INFO`, `METADATA` and `VERSION` are not read.
4. Map each row:
   - A NULL `id`, `word_key` or `book_key` throws `null-id`, naming the table, the column and the row (the lookup id if it has one, otherwise the `rowid`).
   - A text column holding a non-string, non-null value, or a `timestamp` that is not an integer or null, throws `unexpected-type`, naming the table, the row and the column.
   - Text is carried over unchanged, so `""` stays `""` and NULL becomes `null`. Integers come back as JS `number`. Epoch milliseconds fit safely, so `readBigInts` stays off.
5. Build id sets of words and books. For each lookup in id order, a `wordId` not in the word set or a `bookId` not in the book set throws `dangling-reference`, naming the lookup id and the missing key. Lookups are never dropped. Repeated lookups keep their own ids, so all of them stay.
6. Sort each list with `compareIds(a, b)` (`a.id < b.id ? -1 : a.id > b.id ? 1 : 0`, UTF-16 code-unit order). This does not depend on locale or SQLite collation. Return `{ books, words, lookups }`.

`src/vocab-import/reimport.ts`, `reimportVocab: ReimportVocab`
- Build id sets from `existing.lookups`, `existing.words` and `existing.books`.
- `lookups` = `newer.lookups` whose id is not in the existing lookup set.
- `words` = `newer.words` whose id is referenced by a returned lookup's `wordId` and is not in the existing word set. `books` works the same way with `bookId`.
- Each result list is filtered from a `newer` list, so it keeps `newer`'s order. It is sorted again with `compareIds` so the result is sorted even if the input wasn't. Inputs are never mutated. Content differences for known ids are ignored, and lookups missing from `newer` are not reported.

`src/index.ts` exports `parseVocabDb`, `reimportVocab` and `VocabImportError`.

### Tests (written later by the test author, `app/domain/test/`)

They read `app/fixtures/vocab.db` and `vocab-older.db` by a path resolved from `import.meta.dirname`. The edge cases use SQLite files built in a temp directory with the Kindle DDL. "Older plus new equals newer" concatenates the lists and sorts each with the same code-unit order. The read-only scenario compares bytes and `mtimeMs` before and after parsing. No test touches `docs/vocab.db`.

## Contracts

- `app/contracts/src/vocab-import.ts` (new): the zod schemas and inferred types `VocabBook`, `VocabWord`, `VocabLookup`, `VocabImport`, `VocabImportErrorCode`, and the function types `ParseVocabDb` and `ReimportVocab`.
- `app/contracts/src/index.ts`: re-exports them. The previous file exported nothing, so nothing breaks.

## Decisions that need an ADR

None. `node:sqlite` and comparing by id only were settled in the issue. The remaining choices (code-unit sort order, a typed error code) are local to this capability and are recorded here.

## Risks

- **The file gets touched on open.** If the file is in WAL mode, a read-only open can still create `-shm` or `-wal` side files next to it. The file's own bytes and mtime stay the same, which is what the scenario checks. Kindle `vocab.db` and the fixtures use a rollback journal, and `readOnly: true` stops SQLite from writing to the main file.
- **Sort order differs from SQLite's.** Sorting in JS with one comparator, used by both the domain and the tests, avoids a mismatch with SQLite's BINARY collation, which compares UTF-8 bytes.
- **Rows with unexpected types.** SQLite columns are dynamically typed. Explicit type checks fail with a named error instead of letting a mistyped value into the contract types.
- **Large files.** Each table is read fully into memory. Kindle files hold thousands of rows, not millions, so this is fine for now.
- **Re-import equality with orphan words.** If a newer file held a word or book that no lookup references, it would not be returned, so "existing plus returned" would not equal a direct parse. The fixtures have no such rows: the anonymiser keeps only referenced words. This matches the spec's wording ("the words and books those lookups reference").

## Open questions

- `LOOKUPS.timestamp` can be NULL in the Kindle DDL. The design types it as `number | null`, carried over as stored like the text columns. Should a NULL timestamp be an error instead?
- Should a word or book in the newer file that no lookup references be returned by re-import? The spec says no (only referenced ones). Then "existing plus new equals newer" only holds for files without such rows, which is true of Kindle files and the fixtures.
