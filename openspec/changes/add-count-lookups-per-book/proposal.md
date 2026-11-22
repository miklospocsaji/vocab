# Proposal

## Why

The learner wants to see which books sent them to the dictionary most. Today an import yields flat lists of books, words and lookups, and nothing summarises lookups per book. A pure domain function that counts the distinct words looked up in each book of a `VocabImport` gives the UI a single, tested source for that ranking later, without touching how importing works.

## What Changes

- Add a pure domain function that takes a `VocabImport` and returns one entry per book that has at least one lookup, each carrying the book's `id`, `title` (possibly `null`) and `wordCount`.
- A lookup belongs to the book its `bookId` points to. Books with no lookups are left out.
- **The count is the number of distinct words** (distinct word ids) looked up in the book, as the owner decided: the same word looked up three times in a book counts once. Repeats say more about the reader's memory than about the book, and distinct words match how many words from that book are worth practising. A word looked up in two books counts once in each of them. The requirement and the count field are named after words ("Looked-up words are counted per book", `wordCount`) to make this explicit.
- Lookups whose `bookId` matches no book in the given import are not dropped and do not throw: they form one group, counted under a single entry whose `id` and `title` are both `null`. This matters because a `VocabImport` need not come straight from parsing (which already rejects dangling book references); for example, the result of re-import holds new lookups whose books may already be imported and therefore absent from that result. Because it is one group, a word looked up under two different unknown books counts once in it (owner decision).
- An import with no lookups returns an empty list.
- The result is sorted by word count, highest first; ties by book `id`, ascending, with the unknown-book (`null`) entry after every book with the same word count (owner decision: a `null` id has no natural place in ascending id order). Counting distinct words means a book with many repeats of a few words ranks below a book with more different words, and ties are more likely, so the tie-break matters more often.
- The function lives in `app/domain/src/vocab-import/` and is exported from `app/domain/src/index.ts`. It is a domain export only; no contract types are added (owner decision).
- Out of scope: any UI or API showing the ranking, persistence, changes to parsing or re-import (they work as today), changes to `app/contracts/`, filtering by date or language, and per-word statistics.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: gains a derived per-book count of looked-up words over imported data. It is the capability that owns books, words and lookups, so the summary belongs here rather than in a new capability; no other capability is affected.

## Impact

- Code: a new module in `app/domain/src/vocab-import/` and a new export from `app/domain/src/index.ts`, with unit tests in `app/domain/test/`.
- Contracts: none. The owner chose to keep the result type out of `app/contracts/`.
- Dependencies: none. No database, schema or infrastructure changes.
- Complexity: `small` — one capability, one pure function over the existing contract, no contract or schema change.
