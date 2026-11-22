# Proposal

## Why

The learner wants to see which books sent them to the dictionary most. Today an import yields flat lists of books, words and lookups, and nothing summarises lookups per book. A pure domain function that counts lookups per book from a `VocabImport` gives the UI a single, tested source for that ranking later, without touching how importing works.

## What Changes

- Add a pure domain function that takes a `VocabImport` and returns one entry per book that has at least one lookup, each carrying the book's `id`, `title` (possibly `null`) and a count.
- A lookup belongs to the book its `bookId` points to. Books with no lookups are left out.
- Lookups whose `bookId` matches no book in the given import are not dropped and do not throw: they are counted under a single entry whose `id` and `title` are both `null`. This matters because a `VocabImport` need not come straight from parsing (which already rejects dangling book references); for example, the result of re-import holds new lookups whose books may already be imported and therefore absent from that result.
- An import with no lookups returns an empty list.
- The result is sorted by count, highest first; ties by book `id`, ascending.
- The function lives in `app/domain/src/vocab-import/` and is exported from `app/domain/src/index.ts`.
- **What the count measures is not decided** (number of lookups vs. number of distinct words). The issue asks for this to stay open; the delta spec therefore only fixes behaviour that holds under either choice, and the scenario that distinguishes them is listed as an open question to be added once the owner decides.
- Out of scope: any UI or API showing the ranking, persistence, changes to parsing or re-import (they work as today), filtering by date or language, and per-word statistics.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: gains a derived per-book lookup count over imported data. It is the capability that owns books, words and lookups, so the summary belongs here rather than in a new capability; no other capability is affected.

## Impact

- Code: a new module in `app/domain/src/vocab-import/` and a new export from `app/domain/src/index.ts`, with unit tests in `app/domain/test/`.
- Contracts: none required by the issue. If the result entry type (and a function type, like the existing `ParseVocabDb` / `ReimportVocab`) is added to `app/contracts/`, that is an additive contract change (see open questions).
- Dependencies: none. No database, schema or infrastructure changes.
- Complexity: `small` — one capability, a pure function over the existing contract, no schema change. It would become `medium` if the owner wants the result type added to `app/contracts/`.
- Sorting of the `null` entry on ties: the spec places the unmatched-book entry after every real book with the same count, since a `null` id has no natural place in ascending id order. This is a provisional choice for the owner to confirm.
