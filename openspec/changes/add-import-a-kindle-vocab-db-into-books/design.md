# Design

## Overview

`app/domain` gets one synchronous parser and one pure re-import function. The parser opens the file with Node 24's `node:sqlite` `DatabaseSync` in read-only mode. It checks that the file is SQLite and has the three tables, reads `BOOK_INFO`, `WORDS` and `LOOKUPS` into the contract types, checks that every lookup's references resolve, and sorts each list by id. Re-import is a set difference by id over two parse results. The data types and the two function signatures are in `app/contracts`, as zod schemas with inferred types.

## Components

### `app/contracts/src/vocab-import.ts` (new)

- `VocabBookSchema` / `VocabBook`: `{ id: string; title: string | null; authors: string | null; language: string | null }`.
- `VocabWordSchema` / `VocabWord`: `{ id: string; word: string | null; stem: string | null; language: string | null }`.
- `VocabLookupSchema` / `VocabLookup`: `{ id: string; wordId: string; bookId: string; usage: string | null; timestamp: number | null }`.
- `VocabImportSchema` / `VocabImport`: `{ books: VocabBook[]; words: VocabWord[]; lookups: VocabLookup[] }`. This is both the parse result and the re-import result.
- `ParseVocabDb = (path: string) => VocabImport`.
- `ReimportVocab = (imported: VocabImport, parsed: VocabImport) => VocabImport`.
- Everything is re-exported from `app/contracts/src/index.ts`.

### `app/domain/src/vocab-import/parse.ts` (new)

`export const parseVocabDb: ParseVocabDb`

1. Open the file with `new DatabaseSync(path, { readOnly: true })`. Read-only mode means no write, journal or WAL checkpoint can change the file.
2. In one `try`, run `SELECT name FROM sqlite_master WHERE type = 'table'`. If opening the file or this query fails with SQLite's "file is not a database" error (`SQLITE_NOTADB`, errcode 26), throw `Error("<path> is not a SQLite database")`. Rethrow any other error unchanged.
3. Check the tables in the order `WORDS`, `LOOKUPS`, `BOOK_INFO`. For each missing one, throw `Error("<path> has no <TABLE> table")`. A message that lists every missing table is also fine, as long as it names each one.
4. Read only the needed columns:
   - `SELECT id, title, authors, lang FROM BOOK_INFO`
   - `SELECT id, word, stem, lang FROM WORDS`
   - `SELECT id, word_key, book_key, usage, timestamp FROM LOOKUPS`

   Map `lang` to `language`, `word_key` to `wordId` and `book_key` to `bookId`. Values are copied unchanged: SQL `NULL` becomes `null`, and nothing is trimmed or cleaned.
5. A cell whose storage type does not fit its field throws an error that names the table, column and row id. Examples are a number in a text column, or a non-integer `timestamp`. This keeps the contract types honest without coercing data.
6. Build `Set`s of word and book ids. For each lookup, if `wordId` (including `null`) is not a word id, throw `Error("Lookup <id> references missing word <word_key>")`. Do the same for books. No lookup is dropped. Duplicate (word, book) pairs are kept because rows are never grouped.
7. Sort each list with one shared comparator, `compareIds(a, b)`: `a < b ? -1 : a > b ? 1 : 0` (UTF-16 code-unit order). Sorting happens in JavaScript, not with SQL `ORDER BY`, so tests and re-import results use exactly the same order.
8. Close the database in `finally`.

### `app/domain/src/vocab-import/reimport.ts` (new)

`export const reimportVocab: ReimportVocab`

- `known` holds the id sets of `imported.lookups`, `imported.words` and `imported.books`.
- `lookups` are the `parsed.lookups` whose id is not in `known`.
- `words` are the `parsed.words` whose id is referenced by a new lookup and is not in `known`. `books` are chosen the same way. A word or book counts as known whenever `imported` holds it, whether or not a lookup references it.
- Each list is sorted with `compareIds`. Neither input is mutated. Re-importing the same file returns three empty lists.

### `app/domain/src/index.ts`

Exports `parseVocabDb` and `reimportVocab`.

### Tests (`app/domain/test/`)

- **Fixture tests** read `app/fixtures/vocab.db` and `vocab-older.db` through a path resolved from `import.meta.dirname`.
- **Small files** are built in a temp directory with `DatabaseSync` and the Kindle DDL. Reusing the DDL from `app/fixtures/test/helpers/kindle-db.ts` or copying it are both acceptable.
- **"Combined equals direct parse":** concatenate each list of the older parse with the re-import result, sort with `compareIds`, and deep-equal the parse of `vocab.db`.
- **"Parsing leaves the file unchanged":** compare the file's bytes before and after with `readFileSync` + `Buffer.equals`.
- **Never** read `docs/vocab.db`.

## Contracts

- `app/contracts/src/vocab-import.ts` (new): the four zod schemas, their inferred types, and the `ParseVocabDb` / `ReimportVocab` function types.
- `app/contracts/src/index.ts`: re-exports them. The file only exported `{}` before, so nothing breaks.

## Decisions that need an ADR

None. `node:sqlite` is mandated by the issue and needs no new dependency. All other choices are local to this change.

## Risks

- **`@vocab/domain` must depend on `@vocab/contracts`.** `app/domain/package.json` declares no dependencies today, so `"@vocab/contracts": "workspace:*"` must be added and `pnpm-lock.yaml` updated. Neither file is under `app/*/src/`, so per brief section 6 the implementer cannot write them. The planner must give this to a task or role that may edit them, or the import will not resolve.
- **`node:sqlite` stability.** On some Node 24 minors it is still experimental and prints a warning. That does not affect results, but tests must not fail on stderr output.
- **Read-only open of a file with a WAL journal.** A `-wal` file without `-shm` could fail to open read-only. Kindle files use a rollback journal, and the fixtures have no WAL. Any such error propagates unchanged rather than being reported as a missing table.
- **Edge cases of the not-SQLite check.** An empty file opens as an empty database and is reported as missing tables, not as not SQLite. That is still an error that says what is wrong.
- **Sort order.** SQLite `BINARY` order (UTF-8 bytes) and JavaScript order (UTF-16 code units) differ for astral characters. Sorting only in JavaScript with `compareIds` avoids the mismatch.
- **Equivalence of re-import and direct parse.** Combining imported data with the re-import result equals a direct parse only if the newer file contains everything already imported and holds no words or books without a lookup. Both hold for the fixtures, which the anonymiser builds as a subset with only referenced words and books.

## Open questions

- **Orphan words and books.** The spec says the combined data "SHALL equal parsing the newer file directly", but re-import returns only words and books referenced by new lookups. A newer file with a word or book that no lookup references would break that equality. This design follows the issue's narrower rule, which returns only referenced rows. The owner may want to confirm this.
- **NULL timestamps.** `LOOKUPS.timestamp` can in principle be NULL. Following "fields are read as stored", this design types it `number | null` rather than making it an error. The owner may prefer `number` with NULL as a parse error.
