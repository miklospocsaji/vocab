# Proposal

## Why

The learner's only source of vocabulary is the `vocab.db` SQLite file copied from their Kindle. Nothing in the app can read it yet: the anonymised fixtures exist, but there is no importer. Storage, upload and practice all need the same plain data (books, words, lookups) and a way to add only the new lookups when a newer copy of the file arrives. Defining the parser, the re-import rule and the shared data types now gives every later milestone one tested foundation.

## What Changes

- Add an importer in `app/domain` that reads a `vocab.db` at a given path, read-only, into books (id, title, authors, language), words (id, word, stem, language) and lookups (id, word id, book id, usage sentence as stored, timestamp in epoch milliseconds), each list sorted by id.
- Keep every lookup, including repeated lookups of the same word in the same book.
- Report an error naming the lookup id when a lookup's word or book is missing from the file; never drop it silently.
- Report an error saying so when the file is not SQLite or lacks the `WORDS`, `LOOKUPS` or `BOOK_INFO` table.
- Add a re-import operation that, given already imported data and a newly parsed file, returns only the lookups not yet imported and the words and books they reference that are not yet imported.
- Add the book, word, lookup and imported-data types to `app/contracts`; export the types from `app/contracts/src/index.ts` and the importer from `app/domain/src/index.ts`.
- Use Node 24's built-in `node:sqlite`; no new dependencies.
- Out of scope: storing data in a database, uploads, any UI, cleaning usage sentences or locating the word in them (#7), EPUB paragraphs, enrichment, trajectories, and reading `DICT_INFO`, `METADATA` or `VERSION`. Tests never use `docs/vocab.db`.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds parsing of a Kindle `vocab.db` into shared contract types and an incremental re-import that returns only new lookups, words and books.

## Impact

- `app/contracts`: new exported types for books, words, lookups and imported data (a new shared contract).
- `app/domain`: new parser and re-import functions, exported from `src/index.ts`; depends on `app/contracts`.
- Tests read the committed fixtures `app/fixtures/vocab.db` and `app/fixtures/vocab-older.db` and small SQLite files they create.
- No new dependencies, APIs, infrastructure or factory changes.
