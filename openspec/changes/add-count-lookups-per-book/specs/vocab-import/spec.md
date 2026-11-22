## ADDED Requirements

### Requirement: Lookups are counted per book
Given a `VocabImport`, the domain SHALL return one entry per book that has at least one lookup, carrying the book's `id`, its `title` (which may be `null`) and a count. A lookup belongs to the book its `bookId` points to. Books without lookups SHALL be left out. The function SHALL be pure: it SHALL NOT change its input.

#### Scenario: Each book with lookups gets one entry
- **WHEN** an import has book `B1` titled `One` with lookups of two different words, and book `B2` with a `null` title and a lookup of one word
- **THEN** the result holds exactly two entries: `B1` with title `One` and count 2, and `B2` with title `null` and count 1

#### Scenario: Books without lookups are left out
- **WHEN** an import has books `B1` and `B2`, and every lookup points to `B1`
- **THEN** the result has no entry for `B2`

#### Scenario: Input import is not modified
- **WHEN** the per-book counts are computed for an import
- **THEN** the import is deep-equal to a copy taken before the call

### Requirement: Lookups with an unknown book are counted together
Lookups whose `bookId` matches no book in the import SHALL NOT be dropped and SHALL NOT cause an error. They SHALL all be counted under a single entry whose `id` and `title` are both `null`.

#### Scenario: Unmatched lookups share one null entry
- **WHEN** an import has book `B1` with a lookup of one word, and lookups of two different words whose `bookId`s are `X1` and `X2`, neither of which is a book in the import
- **THEN** the call does not throw, and the result holds `B1` with count 1 and exactly one entry with `id` `null`, `title` `null` and count 2

### Requirement: Import without lookups yields no counts
An import with no lookups SHALL produce an empty list.

#### Scenario: No lookups gives an empty list
- **WHEN** an import has books and words but no lookups
- **THEN** the result is an empty list

### Requirement: Per-book counts are ranked
The result SHALL be sorted by count, highest first. Entries with equal counts SHALL be ordered by book `id`, ascending, with the entry for unknown books (`id` `null`) after every book with the same count.

#### Scenario: Higher counts come first
- **WHEN** book `B1` has lookups of one word and book `B2` has lookups of three different words
- **THEN** `B2` comes before `B1`

#### Scenario: Ties are ordered by book id
- **WHEN** books `B2` and `B1` each have a lookup of one word, and one lookup of another word points to a book not in the import
- **THEN** the entries are ordered `B1`, `B2`, then the `null` entry

### Requirement: Per-book count is exported from the domain
The per-book count function SHALL be exported from `app/domain/src/index.ts`. Its tests SHALL use only the committed fixtures and data they build, never `docs/vocab.db`.

#### Scenario: Counts are usable through the domain entry point
- **WHEN** a test imports the per-book count function from the domain package entry point and applies it to the result of parsing `app/fixtures/vocab.db`
- **THEN** it returns a non-empty list in which every entry's `id` is a book id from the parsed import, no entry has a `null` id, and counts never increase from one entry to the next
