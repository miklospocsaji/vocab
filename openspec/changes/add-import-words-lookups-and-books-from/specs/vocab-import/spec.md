## ADDED Requirements

### Requirement: Kindle vocab.db is parsed into books, words and lookups
The importer SHALL read a Kindle `vocab.db` at a given path, opened read-only and without modifying the file, into plain data: books (id, title, authors, language), words (id, word, stem, language) and lookups (id, word id, book id, usage sentence as stored, timestamp in epoch milliseconds). These data types SHALL be exported from `app/contracts` and the importer from `app/domain`.

#### Scenario: Full fixture parses to its known counts
- **WHEN** the importer parses `app/fixtures/vocab.db`
- **THEN** the result holds 4 books, 640 words and 733 lookups, and every lookup's word id and book id match a word and a book in the result

#### Scenario: Older fixture parses to its known lookup count
- **WHEN** the importer parses `app/fixtures/vocab-older.db`
- **THEN** the result holds 550 lookups

#### Scenario: Fields are read as stored
- **WHEN** the importer parses a test file with one book, one word `en:abhors` with stem `abhor`, and one lookup with a usage sentence and timestamp
- **THEN** the result's book, word and lookup carry exactly the stored id, title, authors, language, word, stem, usage sentence and epoch-millisecond timestamp

#### Scenario: Source file is left unchanged
- **WHEN** the importer parses a test file
- **THEN** the file's bytes are identical before and after parsing

### Requirement: Every lookup is kept
The importer SHALL return one lookup for every row of `LOOKUPS`, including repeated lookups of the same word in the same book.

#### Scenario: Repeated lookups of a word in one book are kept
- **WHEN** a test file holds three lookups of the same word in the same book
- **THEN** the result holds all three lookups

### Requirement: Dangling lookup references are errors
The importer SHALL fail with an error naming the lookup id when a lookup references a word or a book that is not in the file. It SHALL NOT return a partial result that silently drops such a lookup.

#### Scenario: Lookup with a missing word is reported
- **WHEN** a test file holds a lookup whose word id is not in `WORDS`
- **THEN** parsing fails with an error that contains that lookup's id

#### Scenario: Lookup with a missing book is reported
- **WHEN** a test file holds a lookup whose book id is not in `BOOK_INFO`
- **THEN** parsing fails with an error that contains that lookup's id

### Requirement: Invalid files are rejected
The importer SHALL fail with an error saying the file is not a SQLite database when it is not one, and with an error naming the missing table when the `WORDS`, `LOOKUPS` or `BOOK_INFO` table is absent.

#### Scenario: Non-SQLite file is rejected
- **WHEN** the importer is given a plain text file
- **THEN** parsing fails with an error saying the file is not a SQLite database

#### Scenario: Missing table is named
- **WHEN** the importer is given a SQLite file without a `BOOK_INFO` table
- **THEN** parsing fails with an error that names `BOOK_INFO`

### Requirement: Parse order is deterministic
The importer SHALL return books, words and lookups each sorted by id, so that parsing the same file twice yields equal results.

#### Scenario: Lists are sorted by id
- **WHEN** a test file's rows are inserted out of id order and the importer parses it
- **THEN** each of the books, words and lookups lists is in ascending id order

### Requirement: Re-import returns only new data
Given already imported data and a newly parsed file, re-import SHALL return the lookups whose id is not already imported, and the words and books those lookups reference that are not already imported. Already imported data plus the returned data SHALL equal the newer file parsed directly.

#### Scenario: Newer file adds only its new lookups
- **WHEN** `app/fixtures/vocab.db` is re-imported over the data parsed from `app/fixtures/vocab-older.db`
- **THEN** exactly 183 lookups are returned, and the older data plus the returned books, words and lookups equals the parse of `app/fixtures/vocab.db`

#### Scenario: Re-importing the same file adds nothing
- **WHEN** `app/fixtures/vocab.db` is re-imported over the data parsed from itself
- **THEN** no books, words or lookups are returned

#### Scenario: Only unknown words and books are returned
- **WHEN** a newer test file adds one lookup of an already imported word in a new book
- **THEN** re-import returns that lookup and the new book, and no words
