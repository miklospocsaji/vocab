# Proposal

## Why

The UI will need to show reading activity, such as a streak or a small calendar, built from the learner's Kindle lookups. The data is already parsed into a `VocabImport`, but nothing groups lookups by day yet. A pure domain function that counts lookups per calendar day gives the UI that view without rereading the file. It also reports lookups with no timestamp, so they are counted rather than silently dropped.

## What Changes

- Add a pure domain function that takes a `VocabImport` and the reader's time zone, and returns how many lookups fell on each calendar day, as a list of `{ day, count }` with `day` a `YYYY-MM-DD` string, oldest day first. Days with no lookups are left out.
- The calendar day is the day in the reader's local time zone, passed in by the caller as an IANA time zone name such as `Europe/Budapest` (owner decision on revision; it replaces the earlier UTC assumption). A timestamp is an instant in epoch milliseconds, so a zone is needed to turn it into a day; passing it in keeps the function pure and its output independent of the machine it runs on. Daylight saving time follows the zone's rules for each lookup's instant.
- A time zone name that is not a valid IANA name makes the function fail with an error naming it, rather than silently falling back to another zone. The issue does not cover this case; failing loudly matches how the importer treats bad input elsewhere.
- Lookups whose `timestamp` is `null` count under no day. The result reports how many there were.
- An import with no lookups gives an empty list and zero undated lookups.
- Export the function from the domain package entry point (`app/domain/src/index.ts`).
- Out of scope: any UI (streak, calendar), counting per book or per word, detecting or storing the reader's time zone (the caller supplies it), persistence, and any change to parsing or re-import, which keep working as they do today.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds a per-day summary of imported lookups. It belongs here because it is derived only from the `VocabImport` this capability produces, and no listed capability covers activity statistics.

## Impact

- Code: a new pure function and its tests in `app/domain/src/vocab-import/`, plus an export in `app/domain/src/index.ts`.
- Contracts: none are expected to change. The function reads the existing `VocabImport` type. Whether the result type should also be a zod contract in `app/contracts/` is an open question. If it should, the complexity rises to medium.
- Dependencies and systems: none expected. Node 24 ships full IANA time-zone data, so no new library should be needed. No schema change, no I/O.
- Complexity: small. One capability, no schema change and no contract change; the time-zone parameter adds an argument and a few scenarios, not a new component.
