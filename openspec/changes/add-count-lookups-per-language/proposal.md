# Proposal

## Why

The UI will need to show how a learner's Kindle lookups split across languages (for example "en 312, de 41"). Nothing in the domain gives that breakdown today, so every caller would have to join lookups to words itself and decide how to handle words without a language or lookups whose word is missing. One pure, tested domain function settles those rules in one place before the UI work starts.

## What Changes

- Add a pure domain function that takes a `VocabImport` and returns a list of `{ language, count }`, one entry per language that has at least one lookup.
- A lookup's language is the `language` of the word its word id points to.
- The list is sorted by count, highest first; ties are sorted by language in ascending order.
- Lookups of words whose language is `null` are counted under `null`, never dropped or merged into another language.
- A lookup whose word id matches no word in the import is counted under `null` and does not cause an error.
- An import with no lookups gives an empty list.
- The function lives with the vocab-import domain code and is exported from the domain package entry point.
- Out of scope: any UI that shows the counts, persistence, counting words or books instead of lookups, and any change to parsing or re-import, which keep working as they do today.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds a per-language lookup count over an imported `VocabImport`.

## Impact

- `app/domain/src/vocab-import/`: a new pure function and its tests.
- `app/domain/src/index.ts`: exports the new function.
- `app/contracts/`: may gain a type for the `{ language, count }` result entry; existing contracts are unchanged.
- No new dependencies, no database or API changes.
