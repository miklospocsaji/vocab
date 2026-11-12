# Proposal

## Why

Kindle lookups carry the sentence the word was looked up in (`LOOKUPS.usage`). These sentences often contain messy whitespace and invisible characters such as soft hyphens and zero-width spaces, which break display and matching. Later steps need to know where the looked-up word sits in its sentence so it can be highlighted on a card. Two small, pure functions give the importer and later cards a clean sentence and the word's position in it.

## What Changes

- Add `cleanUsage(sentence)` to `app/domain`: removes soft hyphens (U+00AD), zero-width spaces (U+200B), zero-width non-joiners (U+200C), zero-width joiners (U+200D) and byte order marks (U+FEFF); collapses every run of whitespace (including U+00A0) to one space; trims both ends; changes nothing else.
- Add `findWord(sentence, word)` to `app/domain`: returns the `{ start, end }` range of the first case-insensitive, whole-word occurrence of `word` in `sentence`, with Unicode-aware word boundaries, or `undefined` when there is none or `word` is empty or only whitespace. It does not clean the sentence.
- Export both from `app/domain/src/index.ts`.
- Out of scope: matching other forms of the word (plurals, conjugations, the Kindle `stem`); reading `vocab.db`, storing anything, or any UI; new dependencies.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds normalisation of Kindle usage sentences and locating the looked-up word within its sentence.

## Impact

- Code: new pure functions in `app/domain` (the package may not exist yet and would be created), exported from `app/domain/src/index.ts`.
- APIs: two new exported functions of `app/domain`; no existing contract changes.
- Dependencies: none added.
- Systems: none; no database, storage or UI changes.
