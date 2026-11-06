# Proposal

## Why

Learners import Kindle lookups from several books, but they cannot see how the words are spread across those books. If the vocabulary list shows how many distinct words were looked up in each book, a learner can see which books have the most to practise and choose where to start. The brief already says every word keeps the book it came from (title, author), so the data is there. Only the per-book summary is missing.

## What Changes

- The vocabulary list shows one entry per imported book, with the book's title, its author(s) and its word count.
- A book's word count is the number of distinct words looked up in that book. A word looked up several times in the same book counts once for that book.
- A word looked up in two different books counts once for each of those books.
- Re-importing the same file does not change any book's word count. Re-importing a newer file updates the counts to include only the new distinct words.
- Out of scope: sorting or filtering books by count, per-book practice decks or progress (the brief's "book shelf"), per-trajectory grouping, known/ignored word handling, and any change to how lookups are parsed or stored.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds a per-book summary of imported words (title, author, distinct word count) shown on the vocabulary list. No existing capability covers the vocabulary list itself, so `vocab-import`, which owns books, words and lookups, is the closest fit.

## Impact

- App: the vocabulary list view and the query that backs it, which reads imported books, words and lookups.
- Contracts: the vocabulary list's response gains a per-book entry with title, authors and word count.
- Tests: the scenarios can be checked against `app/fixtures/vocab.db` and `app/fixtures/vocab-older.db`.
- No new dependencies. The factory (orchestration, roles, gates) is not affected.
