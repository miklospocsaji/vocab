# Proposal

## Why

The UI will need to show reading activity, such as a streak or a small calendar, built from the learner's Kindle lookups. The data is already parsed into a `VocabImport`, but nothing groups lookups by day yet. A pure domain function that counts lookups per calendar day gives the UI that view without rereading the file. It also reports lookups with no timestamp, so they are counted rather than silently dropped.

## What Changes

- Add a pure domain function that takes a `VocabImport` and returns how many lookups fell on each calendar day, as a list of `{ day, count }` with `day` a `YYYY-MM-DD` string, oldest day first. Days with no lookups are left out.
- Lookups whose `timestamp` is `null` count under no day. The result reports how many there were.
- An import with no lookups gives an empty list and zero undated lookups.
- Export the function from the domain package entry point (`app/domain/src/index.ts`).
- The calendar day is taken in UTC. The issue does not name a time zone. UTC keeps the function pure and deterministic, and matches how the fixtures' timestamps are defined (2020-01-01T00:00:00Z). This is an open question for the owner.
- Out of scope: any UI (streak, calendar), counting per book or per word, time-zone settings, persistence, and any change to parsing or re-import, which keep working as they do today.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds a per-day summary of imported lookups. It belongs here because it is derived only from the `VocabImport` this capability produces, and no listed capability covers activity statistics.

## Impact

- Code: a new pure function and its tests in `app/domain/src/vocab-import/`, plus an export in `app/domain/src/index.ts`.
- Contracts: none are expected to change. The function reads the existing `VocabImport` type. Whether the result type should also be a zod contract in `app/contracts/` is an open question. If it should, the complexity rises to medium.
- Dependencies and systems: none. No new libraries, no schema change, no I/O.
- Complexity: small. One capability, no schema change and no contract change.
