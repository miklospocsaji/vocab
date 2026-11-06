## ADDED Requirements

### Requirement: Vocabulary list shows each book with its word count
The vocabulary list SHALL show one entry for each book the learner has imported lookups from. Each entry SHALL show the book's title, its author(s) and its word count.

#### Scenario: Each imported book is listed with title, author and count
- **WHEN** a learner has imported a file with lookups from two books and opens the vocabulary list
- **THEN** the list shows exactly two book entries, each with that book's title, author(s) and word count

### Requirement: Word count counts distinct words per book
A book's word count SHALL equal the number of distinct words looked up in that book. A word looked up several times in one book SHALL count once for that book. A word looked up in several books SHALL count once for each of those books.

#### Scenario: Repeated lookups in one book count once
- **WHEN** a book has three lookups of the same word and one lookup of a different word
- **THEN** that book's word count is 2

#### Scenario: Same word in two books counts for each book
- **WHEN** the same word is looked up once in book A and once in book B, and neither book has other lookups
- **THEN** book A's word count is 1 and book B's word count is 1

### Requirement: Word counts are stable across re-import
Re-importing lookups SHALL change a book's word count only by the number of distinct words in that book that were not imported before.

#### Scenario: Re-importing the same file keeps the counts
- **WHEN** the learner imports the same file twice
- **THEN** every book's word count after the second import equals its count after the first

#### Scenario: Importing a newer file adds only new words to the count
- **WHEN** the learner imports `vocab-older.db` and then `vocab.db`
- **THEN** each book's word count equals the number of distinct words looked up in that book in `vocab.db`
