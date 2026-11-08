# Proposal

## Why

Learners import Kindle lookups from several books, but they cannot see how the words are spread across those books. If the vocabulary list shows how many distinct words were looked up in each book, a learner can see which books have the most to practise and choose where to start. The brief already says every word keeps the book it came from (title, author), so the data is there. Only the per-book summary is missing.

## What Changes

- The vocabulary list shows one entry per imported book, with the book's title, its author(s) and its word count. A book with no lookups is listed with count 0.
- Books are ordered by word count, highest first. Books with the same count are ordered by title, A to Z.
- A book's word count is the number of distinct Kindle word entries (`WORDS.id`) looked up in that book, so inflected forms count separately. A word looked up several times in the same book counts once for that book.
- A word looked up in two different books counts once for each of those books.
- Re-importing the same file does not change any book's word count. Re-importing a newer file updates the counts to include only the new distinct words.
- Out of scope: user-selectable sorting and filtering of books, per-book practice decks or progress (the brief's "book shelf"), and any change to how lookups are parsed or stored. Also out of scope are per-trajectory counts, which come once trajectories exist, and known/ignored word handling: all words count for now.

## Capabilities

### New Capabilities

### Modified Capabilities

- `vocab-import`: adds a per-book summary of imported words (title, author, distinct word count) shown on the vocabulary list. `vocab-import` owns books, words and lookups, so the summary belongs here.

## Impact

- App: the vocabulary list view and the query that backs it, which reads imported books, words and lookups.
- Contracts: the vocabulary list's response gains a per-book entry with title, authors and word count.
- Tests: the scenarios can be checked against `app/fixtures/vocab.db` and `app/fixtures/vocab-older.db`.
- No new dependencies. The factory (orchestration, roles, gates) is not affected.
