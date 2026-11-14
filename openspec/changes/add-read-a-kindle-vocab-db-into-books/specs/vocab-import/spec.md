## ADDED Requirements

### Requirement: Vocab file is parsed into books, words and lookups
The importer SHALL read a Kindle `vocab.db` at a given path into books (id, title, authors, language), words (id, word, stem, language) and lookups (id, word id, book id, usage sentence exactly as stored, timestamp in epoch milliseconds), taken from `BOOK_INFO`, `WORDS` and `LOOKUPS`.

#### Scenario: Full fixture parses to its known counts
- **WHEN** `app/fixtures/vocab.db` is parsed
- **THEN** the result holds 4 books, 640 words and 733 lookups, and every lookup's word id and book id match a word and a book in the result

#### Scenario: Older fixture parses to its known lookup count
- **WHEN** `app/fixtures/vocab-older.db` is parsed
- **THEN** the result holds 550 lookups

#### Scenario: Fields are carried over as stored
- **WHEN** a test-created file holds a word `en:abhors` with stem `abhor`, a book, and a lookup of that word with a usage sentence and timestamp
- **THEN** the parsed word has id `en:abhors`, word `abhors`, stem `abhor` and its language, and the parsed lookup has the identical usage sentence and the same epoch-millisecond timestamp

### Requirement: The vocab file is read without modification
The importer SHALL open the file read-only and SHALL NOT change it.

#### Scenario: Parsing leaves the file unchanged
- **WHEN** a `vocab.db` is parsed
- **THEN** the file's bytes and modification time are the same as before parsing

### Requirement: Every lookup is kept
The importer SHALL return one lookup for every row in `LOOKUPS`, including repeated lookups of the same word in the same book.

#### Scenario: Repeated lookups are all kept
- **WHEN** a test-created file has three lookups of the same word in the same book
- **THEN** the parsed result holds all three lookups

### Requirement: Dangling references are errors
A lookup whose word or book is missing from the file SHALL cause the import to fail with an error naming the lookup id. Such a lookup SHALL never be silently dropped.

#### Scenario: Lookup with a missing word fails
- **WHEN** a test-created file has a lookup whose `word_key` matches no `WORDS.id`
- **THEN** parsing fails with an error that contains that lookup's id

#### Scenario: Lookup with a missing book fails
- **WHEN** a test-created file has a lookup whose `book_key` matches no `BOOK_INFO.id`
- **THEN** parsing fails with an error that contains that lookup's id

### Requirement: Invalid files are rejected
A file that is not a SQLite database, or that lacks the `WORDS`, `LOOKUPS` or `BOOK_INFO` table, SHALL cause the import to fail with an error that says so.

#### Scenario: Non-SQLite file is rejected
- **WHEN** a plain text file is parsed
- **THEN** parsing fails with an error saying the file is not a SQLite database

#### Scenario: Missing table is rejected
- **WHEN** a test-created SQLite file has `WORDS` and `BOOK_INFO` but no `LOOKUPS` table
- **THEN** parsing fails with an error naming the missing `LOOKUPS` table

### Requirement: Parse order is deterministic
The importer SHALL return books, words and lookups each sorted by id.

#### Scenario: Lists are sorted by id
- **WHEN** a test-created file whose rows were inserted out of id order is parsed
- **THEN** each of the books, words and lookups lists is in ascending id order, and parsing the file twice gives equal results

### Requirement: Re-import returns only new data
Given already-imported data and a newly parsed file, re-import SHALL return the lookups whose id is not already imported, and the words and books those lookups reference that are not already imported.

#### Scenario: Newer file adds only new lookups
- **WHEN** `app/fixtures/vocab.db` is re-imported over the data parsed from `app/fixtures/vocab-older.db`
- **THEN** exactly 183 lookups are returned, none of whose ids is in the older data

#### Scenario: Re-importing the same file adds nothing
- **WHEN** `app/fixtures/vocab.db` is re-imported over the data parsed from itself
- **THEN** no lookups, words or books are returned

#### Scenario: Only unknown words and books are returned
- **WHEN** a newer test-created file adds lookups of one known word and one new word, in a known book
- **THEN** re-import returns only the new word and no books

### Requirement: Re-import equals a direct import
Combining the already-imported data with the data re-import returns SHALL equal parsing the newer file directly, when the newer file contains everything already imported.

#### Scenario: Older plus new equals newer
- **WHEN** the data parsed from `app/fixtures/vocab-older.db` is combined with what re-importing `app/fixtures/vocab.db` returns, and each list is sorted by id
- **THEN** the books, words and lookups equal those of parsing `app/fixtures/vocab.db` directly

### Requirement: Import types and functions are exported
The book, word, lookup and import result types SHALL be exported from `app/contracts/src/index.ts`, and the parse and re-import functions from `app/domain/src/index.ts`. Their tests SHALL use only the committed fixtures and SQLite files they create, never `docs/vocab.db`.

#### Scenario: Importer is usable through the package entry points
- **WHEN** a test imports the parse and re-import functions from the domain package entry point and the types from the contracts package entry point
- **THEN** parsing `app/fixtures/vocab.db` through them returns a value that type-checks as the contracts' import result
