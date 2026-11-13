## ADDED Requirements

### Requirement: A vocab.db is parsed into books, words and lookups
The importer SHALL read a Kindle `vocab.db` at a given path, without modifying it, and return books (id, title, authors, language), words (id, word, stem, language) and lookups (id, word id, book id, usage sentence as stored, timestamp in epoch milliseconds), taken from the `BOOK_INFO`, `WORDS` and `LOOKUPS` tables.

#### Scenario: Fixture parses to its books, words and lookups
- **WHEN** `app/fixtures/vocab.db` is parsed
- **THEN** the result holds 4 books, 640 words and 733 lookups, and every lookup's word id and book id match a word and a book in the result

#### Scenario: Older fixture parses to its lookups
- **WHEN** `app/fixtures/vocab-older.db` is parsed
- **THEN** the result holds 550 lookups

#### Scenario: Fields are copied as stored
- **WHEN** a test-created SQLite file holds one book, one word with id `en:abhors` and stem `abhor`, and one lookup with a usage sentence and timestamp, and it is parsed
- **THEN** the result's book, word and lookup carry exactly those stored values, with the usage sentence unchanged and the timestamp as the stored epoch milliseconds

#### Scenario: Parsing leaves the file unchanged
- **WHEN** a test-created `vocab.db` is parsed
- **THEN** the file's bytes are identical before and after parsing

### Requirement: Every lookup is kept
The importer SHALL keep every row of `LOOKUPS`, including repeated lookups of the same word in the same book.

#### Scenario: Repeated lookups are all kept
- **WHEN** a test-created file holds three lookups with distinct ids of the same word in the same book, and it is parsed
- **THEN** the result holds all three lookups

### Requirement: Dangling lookup references are errors
The importer MUST fail with an error naming the lookup id when a lookup's word or book is missing from the file. Such a lookup SHALL never be silently dropped.

#### Scenario: Lookup with a missing word is rejected
- **WHEN** a test-created file holds a lookup whose `word_key` matches no `WORDS.id`, and it is parsed
- **THEN** parsing fails with an error that contains that lookup's id

#### Scenario: Lookup with a missing book is rejected
- **WHEN** a test-created file holds a lookup whose `book_key` matches no `BOOK_INFO.id`, and it is parsed
- **THEN** parsing fails with an error that contains that lookup's id

### Requirement: Invalid files are rejected
The importer MUST fail with an error saying so when the file is not a SQLite database, and with an error naming the missing table when the file lacks the `WORDS`, `LOOKUPS` or `BOOK_INFO` table.

#### Scenario: Non-SQLite file is rejected
- **WHEN** a text file is parsed as a `vocab.db`
- **THEN** parsing fails with an error saying the file is not a SQLite database

#### Scenario: Missing table is rejected
- **WHEN** a test-created SQLite file has `WORDS` and `BOOK_INFO` but no `LOOKUPS` table, and it is parsed
- **THEN** parsing fails with an error that names the `LOOKUPS` table

### Requirement: Parse results are ordered by id
The importer SHALL return books, words and lookups each sorted by id, so that parsing the same file always yields the same result.

#### Scenario: Lists are sorted by id
- **WHEN** a test-created file whose rows were inserted out of id order is parsed
- **THEN** the books, words and lookups in the result are each in ascending id order

### Requirement: Re-import returns only new data
Given already imported data and a newly parsed file, re-import SHALL return the lookups whose id is not already imported, and the words and books those lookups reference that are not already imported. Combining the imported data with the returned data SHALL equal parsing the newer file directly.

#### Scenario: Re-import after the older snapshot adds the new lookups
- **WHEN** `app/fixtures/vocab.db` is re-imported over the parse of `app/fixtures/vocab-older.db`
- **THEN** exactly 183 lookups are returned, and the older data combined with the returned data, sorted by id, equals the parse of `app/fixtures/vocab.db`

#### Scenario: Re-importing the same file adds nothing
- **WHEN** `app/fixtures/vocab.db` is re-imported over its own parse
- **THEN** no lookups, words or books are returned

#### Scenario: Only unknown words and books are returned
- **WHEN** a newer file adds one lookup of an already imported word in a new book, and it is re-imported
- **THEN** the result holds that lookup and the new book, and no words
