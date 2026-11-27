# Proposal

## Why

Today the importer accepts a Kindle `vocab.db` whose `LOOKUPS` table is empty and returns an empty result. Such a file is almost always the wrong one, for example from a fresh Kindle or a copy taken before any lookups. Importing it quietly looks like a successful import with nothing in it, so the learner gets no hint that they picked the wrong file. Rejecting it with a clear error makes the mistake visible.

## What Changes

- Parsing a `vocab.db` that has the expected tables but no rows in `LOOKUPS` fails with the existing import error carrying a new code, `no-lookups`, and the message says the file has no lookups. The check runs after the SQLite and table checks.
- Rows in `WORDS` or `BOOK_INFO` do not change this: a file with no lookups is rejected.
- Re-import inherits this, because the newer file is parsed first: a newer file with no lookups fails when it is read. A newer file that has lookups, none of them new, still gives an empty re-import result, as it does today.
- Files that already fail (not SQLite, missing table) keep their current errors.
- Out of scope: UI handling of the error, and any change to the fixtures or the anonymiser.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: the parser rejects a `vocab.db` with no lookups instead of returning an empty result.

## Impact

- `app/domain` vocab-import parser: a new rejection after the table checks.
- `app/contracts`: `VocabImportErrorCode` gains `no-lookups`, so the change is `medium` (a contract change within one capability). The rejection uses the existing import error type.
- Re-import behaviour for newer files with lookups is unchanged.
- No new dependencies or systems.
