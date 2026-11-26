# Proposal

## Why

The owner wants to know at which hours of the day they read, so that the UI can later suggest a good time to review words. The imported lookups already carry a timestamp (epoch milliseconds, nullable), but nothing turns them into a per-hour picture. Two small pure domain functions over an existing import result give that picture without touching import, re-import or any stored data.

## What Changes

- Add a pure domain function "lookups per hour" that takes an import result and returns a list of `{ hour, count }` for all 24 hours, 0 to 23, in ascending order, including hours with a count of 0, plus the number of lookups whose timestamp is null (undated lookups).
- Undated lookups are counted under no hour, but their number is reported so they are not silently lost.
- An import with no lookups returns 24 zero counts and zero undated lookups.
- Add a pure domain function "peak reading hours" that takes the result of "lookups per hour" and returns the hour or hours with the highest count, in ascending order; it returns an empty list when there are no dated lookups.
- Both functions live in `app/domain/src/vocab-import/` and are exported from the domain package entry point.
- **Not decided here:** which time zone decides a lookup's hour. A Kindle timestamp is epoch milliseconds and `vocab.db` does not record the device's time zone. The issue explicitly asks the proposal to leave this open; the spec therefore only requires that one consistent time zone is used and phrases scenarios in terms of "the hour the timestamp falls in". See open questions.
- Out of scope: any UI or review-time suggestion, persisting the statistics, changes to parsing, import or re-import behaviour (they work as today), per-weekday or per-book breakdowns, and choosing a time-zone policy.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: gains reading-hour statistics derived from an import result. It is the capability that owns the import result and lookups; no other listed capability (trajectories, enrichment, practice, auth) fits. A dedicated statistics capability would need an owner decision and is not proposed.

## Impact

- Code: two new pure functions under `app/domain/src/vocab-import/`, exported from `app/domain/src/index.ts`, with unit tests.
- Contracts: none required; the lookup's timestamp is already nullable in `app/contracts`. Whether the result shape should become a zod contract is an open question for the design step.
- Dependencies: none expected; a time-zone library may become relevant depending on the time-zone answer.
- Complexity is `small`: one capability, no schema or contract change, no change to existing behaviour.
