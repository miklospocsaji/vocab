# Proposal

## Why

The owner wants to know at which hours of the day they read, so that the UI can later suggest a good time to review words. The imported lookups already carry a timestamp (epoch milliseconds, nullable), but nothing turns them into a per-hour picture. Two small pure domain functions over an existing import result give that picture without touching import, re-import or any stored data.

## What Changes

- Add a pure domain function "lookups per hour" that takes an import result and returns a list of `{ hour, count }` for all 24 hours, 0 to 23, in ascending order, including hours with a count of 0, plus the number of lookups whose timestamp is null (undated lookups).
- Undated lookups are counted under no hour, but their number is reported so they are not silently lost.
- An import with no lookups returns 24 zero counts and zero undated lookups.
- Add a pure domain function "peak reading hours" that takes the result of "lookups per hour" and returns the hour or hours with the highest count, in ascending order; it returns an empty list when there are no dated lookups.
- Both functions live in `app/domain/src/vocab-import/` and are exported from the domain package entry point.
- A lookup's hour is the **UTC hour** of its timestamp (owner decision). A Kindle timestamp is epoch milliseconds and `vocab.db` does not record the device's time zone, so UTC is the only zone the data itself supports; it also keeps the functions independent of the host's local zone. The functions take no time-zone parameter. Consequence, accepted by the owner: hours are UTC, not the reader's wall-clock hours (e.g. 21:00 in Central Europe is counted as 19 or 20 UTC). The spec includes a scenario with concrete timestamps so an off-by-offset bug is caught.
- The result shape is a plain TypeScript type in the domain package, exported from its entry point; no zod contract is added (owner decision, to keep the change small).
- Out of scope: any UI or review-time suggestion, persisting the statistics, changes to parsing, import or re-import behaviour (they work as today), per-weekday or per-book breakdowns, local or caller-supplied time zones, and zod contracts for the result.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: gains reading-hour statistics derived from an import result. It is the capability that owns the import result and lookups; no other listed capability (trajectories, enrichment, practice, auth) fits. The owner confirmed keeping it under `vocab-import`; no dedicated statistics capability is proposed.

## Impact

- Code: two new pure functions and a plain TypeScript result type under `app/domain/src/vocab-import/`, exported from `app/domain/src/index.ts`, with unit tests.
- Contracts: none; `app/contracts` is unchanged (the lookup's timestamp is already nullable there) and no zod schema is added for the result.
- Dependencies: none; the UTC hour follows directly from the epoch-millisecond timestamp.
- Complexity is `small`: one capability, no schema or contract change, no change to existing behaviour.
