# 0005 Fixture anonymisation

Status: accepted (2026-10-27; owner decision of 2026-10-26)

## Context

The importer (M3) must be tested against a real Kindle `vocab.db`. The owner's file (2,038 words, 2,706 lookups, 38 books with lookups, all English) contains identifiers:
- book ids and GUIDs (40 characters, for example `CR!…`)
- ASINs in `BOOK_INFO` and `DICT_INFO`
- lookup ids that embed the book id
- a `profileid` column (empty in this file)

Timestamps reveal when the owner read what. The original file must never enter git.

## Decision

- The original stays outside the tracked tree (`docs/vocab.db` is git-ignored). A committed script, `app/fixtures/scripts/anonymise-vocab-db.ts`, produces `app/fixtures/vocab.db` from it.
- The script keeps the schema exactly (same tables, columns and indexes) and keeps the real words, stems, sentences (`usage`), titles and authors for a selected few books.
- It replaces identifiers with deterministic placeholders and keeps them consistent across tables:
  - book ids, GUIDs, ASINs
  - the book part of lookup ids
  - dictionary ASINs
  - profile ids
- It shifts all timestamps by one constant offset. That preserves order and gaps, but not the real dates.
- It also writes an older snapshot, `app/fixtures/vocab-older.db`: the same data cut at a timestamp. Idempotent re-import can then be tested as "older, then newer".
- The script is deterministic: the same input and options produce byte-identical output. It runs on Node 24 with `node:sqlite`, so there is no native dependency.

## Alternatives

- Synthetic data: no privacy risk, but it misses the quirks of real files, such as empty `dict_key`, positions as strings and sideloaded `CR!` ids.
- Committing the real file: rejected by the owner.

## Consequences

- The fixture can be regenerated whenever the owner exports a newer `vocab.db`.
- Real sentences and titles of the selected books are public in the repo. That is acceptable per the owner decision; the selection is the owner's.
