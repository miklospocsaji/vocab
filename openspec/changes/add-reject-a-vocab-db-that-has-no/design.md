# Design

## Overview

`parseVocabDb` gets one more guard, placed directly after the existing missing-table check: if `LOOKUPS` has no rows, it throws `VocabImportError` with the new code `no-lookups` and a message saying the file has no lookups. The contracts' `VocabImportErrorCode` enum gains `no-lookups`. Re-import is not changed. A newer file is always parsed before `reimportVocab` runs, so a newer file with no lookups fails when it is read. A newer file whose lookups are all known still gives an empty result, as it does today.

## Components

### `app/contracts` (`src/vocab-import.ts`)
- `VocabImportErrorCode` gains the value `no-lookups`. `VocabImportError.code` in the domain package is typed from it, so the domain code type-checks with no other change.
- The `ParseVocabDb` doc comment now says the function never returns an empty `lookups` list. The signature is unchanged.

### `app/domain` (`src/vocab-import/parse.ts`)
- In `parseVocabDb`, right after the `missing-table` check and before any rows are read:
  - run `SELECT EXISTS(SELECT 1 FROM LOOKUPS) AS has` (or an equivalent `LIMIT 1` query).
  - If it returns 0, throw `new VocabImportError("no-lookups", \`${path} has no lookups\`)`.
- Order of checks: open / not SQLite → missing table → **no lookups** → row-level checks (`null-id`, `unexpected-type`, `dangling-reference`). Errors that come earlier are unchanged, so a file without a `LOOKUPS` table still reports `missing-table`.
- Rows in `WORDS` and `BOOK_INFO` are not looked at by this check, so they cannot change the result.
- Reads only. The connection stays read-only, as before.

### `app/domain` (`src/vocab-import/reimport.ts`)
- No change. `reimportVocab(existing, newer)` takes already-parsed data, and `newer` can only come from `parseVocabDb`, which now throws for a file with no lookups.

### Tests (`app/domain`)
- New `it("Scenario: …")` cases for the five spec scenarios. They use SQLite files created in a temp dir: empty tables, rows only in `WORDS`/`BOOK_INFO`, no `LOOKUPS` table, and a newer file with no lookups read over `vocab-older.db`. The last case reuses `vocab-older.db` over `vocab.db`. Assert `err.code === "no-lookups"` and a message that matches `/no lookups/`.

## Contracts

- `app/contracts/src/vocab-import.ts`: added `"no-lookups"` to `VocabImportErrorCode`, and updated the `ParseVocabDb` doc comment. This is additive. No export is removed or renamed, and no code matches exhaustively over the enum today.

## Decisions that need an ADR

None. The change adds one value to an existing error enum and one validation step, and it follows the existing error pattern.

## Risks

- **A valid but not-yet-used Kindle is rejected.** The issue intends this. The error code lets the UI give a targeted hint later.
- **Interaction with row-level errors.** A file with no lookups and a malformed `WORDS` row now reports `no-lookups`, not `null-id`/`unexpected-type`. This follows "after the SQLite and table checks" and is the more useful message. A file with no lookups cannot have a `dangling-reference`.
- **Tests that relied on an empty file parsing successfully.** Any existing test that builds a file with an empty `LOOKUPS` table and expects success would now fail. The implementer should check the existing domain tests and give such fixtures a lookup.

## Open questions

None.
