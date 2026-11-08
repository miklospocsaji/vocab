## ADDED Requirements

### Requirement: Vocabulary list shows each book with its word count
The vocabulary list SHALL show one entry for each book in the files the learner has imported, including a book with no lookups, whose word count is 0. Each entry SHALL show the book's title, its author(s) and its word count. Entries SHALL be ordered by word count, highest first, and entries with the same word count SHALL be ordered by title, A to Z.

#### Scenario: Each imported book is listed with title, author and count
- **WHEN** a learner has imported a file with two books, each with lookups, and opens the vocabulary list
- **THEN** the list shows exactly two book entries, each with that book's title, author(s) and word count

#### Scenario: A book with no lookups is listed with count 0
- **WHEN** a learner has imported a file containing a book with no lookups
- **THEN** the list shows an entry for that book with word count 0

#### Scenario: Books are ordered by word count, highest first
- **WHEN** a learner has imported books with word counts 2, 5 and 3
- **THEN** the list shows them in the order 5, 3, 2

#### Scenario: Books with the same word count are ordered by title
- **WHEN** a learner has imported books titled "Zama" and "Austerlitz", each with word count 4
- **THEN** the list shows "Austerlitz" before "Zama"

### Requirement: Word count counts distinct words per book
A book's word count SHALL equal the number of distinct Kindle word entries (`WORDS.id`) looked up in that book. A word looked up several times in one book SHALL count once for that book. A word looked up in several books SHALL count once for each of those books.

#### Scenario: Repeated lookups in one book count once
- **WHEN** a book has three lookups of the same word and one lookup of a different word
- **THEN** that book's word count is 2

#### Scenario: Same word in two books counts for each book
- **WHEN** the same word is looked up once in book A and once in book B, and neither book has other lookups
- **THEN** book A's word count is 1 and book B's word count is 1

#### Scenario: Inflected forms count separately
- **WHEN** a book has lookups of `de:Haus` and `de:Hauses`, which share the stem `Haus`
- **THEN** that book's word count is 2

### Requirement: Word counts are stable across re-import
Re-importing lookups SHALL change a book's word count only by the number of distinct words in that book that were not imported before.

#### Scenario: Re-importing the same file keeps the counts
- **WHEN** the learner imports the same file twice
- **THEN** every book's word count after the second import equals its count after the first

#### Scenario: Importing a newer file adds only new words to the count
- **WHEN** the learner imports `vocab-older.db` and then `vocab.db`
- **THEN** each book's word count equals the number of distinct words looked up in that book in `vocab.db`
