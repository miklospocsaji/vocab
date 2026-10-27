# Proposal

## Why

The importer (M3) must be built and tested against a real Kindle `vocab.db`, with all of its quirks:
- sideloaded `CR!` book ids
- empty `dict_key`
- positions stored as strings
- words looked up several times

The owner's file holds identifiers and reading timestamps that must not be published (ADR 0005). The fixture has to be anonymised, reproducible and committed.

## What Changes

- A committed script, `app/fixtures/scripts/anonymise-vocab-db.ts`, that turns the owner's `vocab.db` into an anonymised fixture:
  - It keeps the real words, stems, sentences, titles and authors of the books the owner selects.
  - It replaces identifiers with consistent placeholders.
  - It shifts timestamps by a constant.
- Two committed fixtures: `app/fixtures/vocab.db`, and `app/fixtures/vocab-older.db`, an earlier cut of the same data for idempotent re-import tests.
- Tests that check both the script (on a synthetic Kindle-shaped database) and the committed fixtures.

Out of scope:
- the importer itself (M3)
- EPUB fixtures (M7)
- fixtures in languages other than English

## Capabilities

### New Capabilities
- `vocab-import`: getting Kindle lookups into the app. This change adds only the test-data requirements; the importer's requirements arrive in M3.

### Modified Capabilities

## Impact

- New package `app/fixtures` (`@vocab/fixtures`) with the script, tests and the two `.db` files (a few hundred KB).
- Uses `node:sqlite` from Node 24; no new dependencies.
- The original `docs/vocab.db` stays git-ignored.
