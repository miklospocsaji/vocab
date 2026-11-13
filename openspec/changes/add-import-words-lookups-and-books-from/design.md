# Design

## Overview

`app/contracts` defines the data read from a Kindle `vocab.db` as zod schemas with inferred types (`Book`, `Word`, `Lookup`, `ImportedVocab`), plus the signatures of the two operations. `app/domain` puts them into practice with two functions: `parseVocabDb(path)` opens the file read-only with Node 24's built-in `node:sqlite`, reads the three tables, checks references and returns lists sorted by id. `reimport(imported, newer)` is a pure set difference by id. No storage, no I/O beyond the read-only open, and no new external dependencies.

## Components

### `app/contracts/src/vocab-import.ts` (exported from `src/index.ts`)

- `Book { id: string; title: string | null; authors: string | null; language: string | null }`, from `BOOK_INFO (id, title, authors, lang)`. `authors` is the single stored string.
- `Word { id: string; word: string | null; stem: string | null; language: string | null }`, from `WORDS (id, word, stem, lang)`.
- `Lookup { id: string; wordId: string; bookId: string; usage: string | null; timestamp: number }`, from `LOOKUPS (id, word_key, book_key, usage, timestamp)`. `timestamp` is epoch milliseconds as stored.
- `ImportedVocab { books: Book[]; words: Word[]; lookups: Lookup[] }`, each list sorted by id in ascending order.
- `ParseVocabDb = (path: string) => ImportedVocab`
- `Reimport = (imported: ImportedVocab, newer: ImportedVocab) => ImportedVocab`

### `app/domain/src/vocab-import/parse.ts`: `export const parseVocabDb: ParseVocabDb`

1. If the first 16 bytes of the file are not `"SQLite format 3\0"`, throw `VocabImportError` with the message `<path> is not a SQLite database`. Also do this if opening or the first query fails with a SQLite "not a database"/`SQLITE_NOTADB` error. A missing file is reported by the normal `ENOENT` error.
2. Open with `new DatabaseSync(path, { readOnly: true })`. Close it in `finally`. Nothing is written, so the file's bytes stay unchanged. The importer never opens it read-write, never runs a pragma that writes, and never creates a journal.
3. Query `sqlite_master` for `type='table'`. For each of `WORDS`, `LOOKUPS` and `BOOK_INFO` in that order, throw `VocabImportError` with `<path> lacks the <TABLE> table` if it is absent.
4. `SELECT id, title, authors, lang FROM BOOK_INFO ORDER BY id`, `SELECT id, word, stem, lang FROM WORDS ORDER BY id` and `SELECT id, word_key, book_key, usage, timestamp FROM LOOKUPS ORDER BY id`. Every row is mapped field by field with no trimming or cleaning. SQL `NULL` in a text column becomes `null`.
5. Build id sets of words and books. For each lookup, if `word_key` is null or not in the word set, throw `VocabImportError` with `lookup <id> references missing word <word_key>`. Do the same for `book_key` with "book". No partial result is returned.
6. Sort each list again in JS by id, using code-unit comparison (`a < b ? -1 : a > b ? 1 : 0`), so the order does not depend on SQLite collation. This order is the contract's "sorted by id".

`VocabImportError extends Error` (no parameter properties) is exported so callers can tell import failures apart from other errors.

### `app/domain/src/vocab-import/reimport.ts`: `export const reimport: Reimport`

- `newLookups` = the `newer.lookups` whose id is not in `imported.lookups`.
- `newWords` = the `newer.words` whose id is referenced by some `newLookups[].wordId` and is not in `imported.words`. `newBooks` works the same way with `bookId`.
- The result keeps `newer`'s order, so it is already sorted by id. Comparison is by id only: changed content of a known id is not reported.
- The function is pure and does not mutate its inputs.

Property for tests: `merge(imported, reimport(imported, newer))` equals `newer`. Here `merge` concatenates each list and sorts it by id. This holds when `imported` is a parse of an older snapshot of the same file, which is the case for the fixtures. The test can write the merge inline. It is not part of the public API.

### `app/domain/src/index.ts`

Exports `parseVocabDb`, `reimport` and `VocabImportError`. `app/domain/package.json` gains `"@vocab/contracts": "workspace:*"` (an internal workspace package, not a new external dependency), and the lockfile is updated to match.

### Tests (`app/domain/test/`)

They read `app/fixtures/vocab.db` and `vocab-older.db` through paths relative to `import.meta.dirname`. They build small Kindle-shaped files in a temp directory with `node:sqlite`, using the Kindle DDL. They never touch `docs/vocab.db`.

## Contracts

- Added `app/contracts/src/vocab-import.ts`: zod schemas and types `Book`, `Word`, `Lookup` and `ImportedVocab`, plus the function types `ParseVocabDb` and `Reimport`.
- Changed `app/contracts/src/index.ts`: re-exports them. It exported nothing before, so nothing breaks.

## Decisions that need an ADR

None. `node:sqlite` is required by the issue, and it is the same module the fixture anonymiser already uses. Domain types live in `app/contracts`, as section 5 of the brief already prescribes.

## Risks

- **Writing to the Kindle file.** Opening the file with `readOnly: true` and running only SELECTs avoids WAL and journal creation. A test compares the file's bytes before and after a parse.
- **`node:sqlite` stability.** The module is built into Node 24 and may print an experimental warning. The importer does not depend on any API beyond `DatabaseSync`, `prepare` and `all`, which the fixtures package already uses.
- **Non-SQLite detection.** The error SQLite reports for a non-database differs by case: on open, on the first query, or for an empty file. The header check makes the message the same in every case.
- **Large integers.** Epoch milliseconds fit well within `Number.MAX_SAFE_INTEGER`, so the default number reads are exact.
- **Sort order.** Comparing in JS rather than relying on SQLite collation keeps "sorted by id" identical in the parse and in the re-import merge.

## Open questions

- In the fixtures, `LOOKUPS.timestamp` is never NULL, but the schema allows NULL. The design treats a NULL timestamp like any other unreadable lookup and throws a `VocabImportError` that names the lookup id. The alternative is to type `timestamp` as `number | null`. The issue makes only text columns nullable. Please confirm.
- The implementer's writable paths (`app/*/src/`) don't cover `app/domain/package.json` or `pnpm-lock.yaml`, but the workspace dependency on `@vocab/contracts` needs both. Who adds that dependency: the planner or the owner?
