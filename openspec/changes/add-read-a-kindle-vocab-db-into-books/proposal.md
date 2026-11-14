# Proposal

## Why

The learner's vocabulary lives in the Kindle's `system/vocabulary/vocab.db`, a SQLite file with every looked-up word, the sentence it was looked up in, and the books. Nothing in the app can read it yet, and storage, upload and practice all depend on that data. The learner also keeps reading and copies newer versions of the file, so a re-import must add only the new lookups without duplicating what is already there.

## What Changes

- Add an importer to `app/domain` that reads a `vocab.db` at a given path, read-only, into plain data: books (id, title, authors, language), words (id, word, stem, language) and lookups (id, word id, book id, usage sentence as stored, timestamp in epoch milliseconds).
- Every lookup is kept, including repeated lookups of the same word in the same book; each list is sorted by id.
- A lookup whose word or book is missing from the file is an error naming the lookup id. A file that is not SQLite, or lacks `WORDS`, `LOOKUPS` or `BOOK_INFO`, is an error that says so.
- Add a re-import function that, given already-imported data and a newly parsed file, returns only the new lookups and the words and books they reference that are not already imported.
- Add the shared data types to `app/contracts`; export the types from `app/contracts/src/index.ts` and the importer from `app/domain/src/index.ts`.
- Out of scope: storing anything in a database, uploads, any UI; cleaning usage sentences or locating the word in them (#7); EPUB paragraphs, enrichment and trajectories; new dependencies (the importer uses Node 24's built-in `node:sqlite`). `DICT_INFO`, `METADATA` and `VERSION` are not read.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds parsing of a Kindle `vocab.db` into books, words and lookups, and idempotent re-import of a newer copy, with the shared contract types.

## Impact

- `app/contracts`: new exported types for books, words, lookups and an import result (a contract change).
- `app/domain`: new parse and re-import functions, exported from `src/index.ts`, with tests against `app/fixtures/vocab.db`, `app/fixtures/vocab-older.db` and small SQLite files the tests create. Tests never use `docs/vocab.db`.
- Dependencies: none added; relies on Node 24's `node:sqlite`.
- No change to the factory, infrastructure or other capabilities.
