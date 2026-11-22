## ADDED Requirements

### Requirement: Looked-up words are counted per book
Given a `VocabImport`, the domain SHALL return one entry per book that has at least one lookup, carrying the book's `id`, its `title` (which may be `null`) and `wordCount`: the number of distinct words (distinct word ids) among the lookups pointing to that book via `bookId`. Books without lookups SHALL be left out. The function SHALL be pure: it SHALL NOT change its input.

#### Scenario: Each book with lookups gets one entry
- **WHEN** an import has book `B1` titled `One` with lookups of two different words, and book `B2` with a `null` title and a lookup of one word
- **THEN** the result holds exactly two entries: `B1` with title `One` and word count 2, and `B2` with title `null` and word count 1

#### Scenario: Repeated lookups of one word count once
- **WHEN** an import has book `B1` with three lookups of the same word
- **THEN** the result holds `B1` with word count 1

#### Scenario: A word looked up in two books counts in each
- **WHEN** an import has books `B1` and `B2`, and the same word is looked up once in `B1` and once in `B2`
- **THEN** the result holds `B1` with word count 1 and `B2` with word count 1

#### Scenario: Books without lookups are left out
- **WHEN** an import has books `B1` and `B2`, and every lookup points to `B1`
- **THEN** the result has no entry for `B2`

#### Scenario: Input import is not modified
- **WHEN** the per-book word counts are computed for an import
- **THEN** the import is deep-equal to a copy taken before the call

### Requirement: Words looked up in an unknown book are counted together
Lookups whose `bookId` matches no book in the import SHALL NOT be dropped and SHALL NOT cause an error. They SHALL form a single group with one entry whose `id` and `title` are both `null`, and whose word count is the number of distinct words among all those lookups, whichever unknown `bookId` they carry.

#### Scenario: Unmatched lookups share one null entry
- **WHEN** an import has book `B1` with a lookup of one word, and lookups of two different words whose `bookId`s are `X1` and `X2`, neither of which is a book in the import
- **THEN** the call does not throw, and the result holds `B1` with word count 1 and exactly one entry with `id` `null`, `title` `null` and word count 2

#### Scenario: A word under two unknown books counts once
- **WHEN** an import has no book `X1` or `X2`, and the same word is looked up once with `bookId` `X1` and once with `bookId` `X2`
- **THEN** the result holds exactly one entry with `id` `null`, `title` `null` and word count 1

### Requirement: Import without lookups yields no counts
An import with no lookups SHALL produce an empty list.

#### Scenario: No lookups gives an empty list
- **WHEN** an import has books and words but no lookups
- **THEN** the result is an empty list

### Requirement: Per-book word counts are ranked
The result SHALL be sorted by word count, highest first. Entries with equal word counts SHALL be ordered by book `id`, ascending, with the entry for unknown books (`id` `null`) after every book with the same word count.

#### Scenario: Higher counts come first
- **WHEN** book `B1` has lookups of one word and book `B2` has lookups of three different words
- **THEN** `B2` comes before `B1`

#### Scenario: Many repeats of few words rank below many distinct words
- **WHEN** book `B1` has five lookups of one word and book `B2` has one lookup each of two different words
- **THEN** `B2` with word count 2 comes before `B1` with word count 1

#### Scenario: Ties are ordered by book id
- **WHEN** books `B2` and `B1` each have a lookup of one word, and one lookup of another word points to a book not in the import
- **THEN** the entries are ordered `B1`, `B2`, then the `null` entry

### Requirement: Per-book word count is exported from the domain
The per-book word count function SHALL be exported from `app/domain/src/index.ts`. Its tests SHALL use only the committed fixtures and data they build, never `docs/vocab.db`.

#### Scenario: Counts are usable through the domain entry point
- **WHEN** a test imports the per-book word count function from the domain package entry point and applies it to the result of parsing `app/fixtures/vocab.db`
- **THEN** it returns a non-empty list in which every entry's `id` is a book id from the parsed import, no entry has a `null` id, and word counts never increase from one entry to the next
