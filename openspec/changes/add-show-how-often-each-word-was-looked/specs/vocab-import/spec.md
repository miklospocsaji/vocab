## ADDED Requirements

### Requirement: Word entries show their lookup count
The word list SHALL contain one entry per imported Kindle word entry (`WORDS.id`). Each entry SHALL show the word as it was looked up and its lookup count: the number of imported lookups referencing that word entry, across all books.

#### Scenario: Count sums lookups across books
- **WHEN** an imported file has three lookups of one word entry, two in one book and one in another
- **THEN** the word list shows that word as it was looked up with a lookup count of 3

#### Scenario: Inflected forms are counted separately
- **WHEN** an imported file has two lookups of the word entry "ran" and one lookup of the word entry "running", both with stem "run"
- **THEN** the word list shows "ran" with a count of 2 and "running" with a count of 1 as separate entries

### Requirement: Word list is ordered by lookup count
The word list SHALL be ordered by lookup count, highest first. Entries with the same lookup count SHALL be ordered alphabetically by the word, ignoring case.

#### Scenario: Most looked-up word comes first
- **WHEN** the imported words have lookup counts 1, 5 and 3
- **THEN** the word list shows them in the order of counts 5, 3, 1

#### Scenario: Equal counts are ordered alphabetically ignoring case
- **WHEN** the words "banana", "Apple" and "cherry" each have a lookup count of 2
- **THEN** the word list shows them in the order "Apple", "banana", "cherry"

### Requirement: Re-import keeps lookup counts accurate
Importing a file whose lookups were already imported SHALL NOT change any lookup count. Importing a newer file SHALL increase counts only by the lookups not imported before.

#### Scenario: Re-importing the same file leaves counts unchanged
- **WHEN** `app/fixtures/vocab.db` is imported and then imported again
- **THEN** every word entry's lookup count is the same after the second import as after the first

#### Scenario: Newer file adds only its new lookups
- **WHEN** `app/fixtures/vocab-older.db` is imported and then `app/fixtures/vocab.db` is imported
- **THEN** every word entry's lookup count equals the number of lookups of that word entry in `app/fixtures/vocab.db`
