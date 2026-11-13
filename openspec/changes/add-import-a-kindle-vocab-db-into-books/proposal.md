# Proposal

## Why

A learner's Kindle keeps every word they looked up, with the sentence and the book, in `system/vocabulary/vocab.db`. The app has anonymised fixtures of this file but nothing that reads it yet. Storage, upload and practice all need the lookups as plain, shared data, and learners will copy newer versions of the file over time, so re-importing must add only the lookups that are new. This is the first step of getting a learner's vocabulary into the app.

## What Changes

- Add an importer in `app/domain` that reads a `vocab.db` at a given path, read-only, into books (id, title, authors, language), words (id, word, stem, language) and lookups (id, word id, book id, usage sentence as stored, timestamp in epoch milliseconds).
- Keep every lookup, including repeated lookups of the same word in the same book; sort each list by id.
- Fail with an error naming the lookup id when a lookup references a word or book missing from the file; fail with a clear error when the file is not SQLite or lacks the `WORDS`, `LOOKUPS` or `BOOK_INFO` table.
- Add a re-import operation that, given already imported data and a newly parsed file, returns only the lookups with new ids and the words and books they reference that are not already imported.
- Add the book, word, lookup and import-result data types to `app/contracts`, and export the types and the importer from each package's `src/index.ts`.
- Use Node 24's built-in `node:sqlite`; no new dependencies.
- Out of scope: storing data in a database, uploads, any UI, cleaning usage sentences or locating the word in them (#7), EPUB paragraphs, enrichment, trajectories (including filing words under a trajectory), and `DICT_INFO`, `METADATA` and `VERSION` tables.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds parsing of a Kindle `vocab.db` into books, words and lookups, and re-import that returns only new data.

## Impact

- `app/contracts`: new exported data types for books, words, lookups and the import result (a contract addition shared by later storage, upload and practice work).
- `app/domain`: new parse and re-import functions, exported from `src/index.ts`.
- Tests read the committed fixtures `app/fixtures/vocab.db` and `app/fixtures/vocab-older.db` and small SQLite files they create; never `docs/vocab.db`.
- No new dependencies; relies on Node 24's `node:sqlite`. No factory, infrastructure or API changes.
