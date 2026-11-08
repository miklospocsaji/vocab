# Proposal

## Why

Learners look up some words again and again, but nothing shows them which words those are. Showing how many times each word was looked up, with the most-looked-up words first, lets the learner see which words keep tripping them up. The lookup data is already in Kindle's `vocab.db` (`LOOKUPS.word_key` referencing `WORDS.id`), so the count can come straight from imported lookups.

## What Changes

- The word list shows one entry per Kindle word entry (`WORDS.id`), with the word as it was looked up and its lookup count.
- The lookup count is the number of imported lookups of that word entry across all books. Inflected forms are separate word entries and are counted separately.
- The word list is ordered by lookup count, highest first; ties are ordered alphabetically, ignoring case.
- Re-importing the same file leaves every count unchanged; importing a newer file adds only its new lookups to the counts.
- Out of scope: per-book counts, per-trajectory grouping, known or ignored words, user-selectable sorting or filtering, and any merging of inflected forms by stem.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds a word list with per-word lookup counts derived from imported lookups, its ordering, and how counts behave on re-import.

## Impact

- `app/domain/` import logic: counting lookups per word entry and ordering the word list.
- The word list view or API that presents imported words gains a lookup count per entry (a new or changed contract under `app/contracts/` if one exists).
- Tests run against the committed fixtures `app/fixtures/vocab.db` and `app/fixtures/vocab-older.db`.
- No new dependencies; no change to factory capabilities.
