# vocab-import Specification

## Purpose
Getting a learner's Kindle lookups into the app: parsing `vocab.db` (words, lookups, books), filing words under the matching trajectory, idempotent re-import, and the anonymised fixtures the importer is tested against.

## Requirements

### Requirement: Anonymised fixture keeps the Kindle schema
The anonymiser SHALL produce a SQLite database with exactly the same tables, columns, column types and indexes as its input Kindle `vocab.db`.

#### Scenario: Schema is unchanged
- **WHEN** the anonymiser runs on a Kindle `vocab.db`
- **THEN** the `sqlite_master` table and index definitions of the output equal those of the input

### Requirement: Identifiers are replaced consistently
The anonymiser SHALL replace every book id, book GUID, book ASIN, dictionary ASIN and profile id with a placeholder, and SHALL rewrite the book part of every lookup id. The same original value SHALL map to the same placeholder everywhere, so every reference still resolves.

#### Scenario: No original identifier survives
- **WHEN** the anonymiser runs on an input containing known book ids, GUIDs, ASINs and profile ids
- **THEN** none of those values appears anywhere in the output, including inside lookup ids

#### Scenario: References still resolve
- **WHEN** the anonymiser has produced an output
- **THEN** every `LOOKUPS.book_key` matches a `BOOK_INFO.id` and every `LOOKUPS.word_key` matches a `WORDS.id` in the output

### Requirement: Selected books keep their real content
The anonymiser SHALL keep only the books selected by the caller, their lookups, and the words those lookups reference. For kept rows it SHALL leave the word, stem, language, usage sentence, position, title and authors unchanged.

#### Scenario: Only selected books are kept
- **WHEN** the anonymiser runs with two of five input books selected
- **THEN** the output contains exactly those two books, all of their lookups, and only the words referenced by those lookups

#### Scenario: Sentences are kept verbatim
- **WHEN** a kept lookup has a usage sentence in the input
- **THEN** the corresponding output lookup has the identical usage sentence

### Requirement: Timestamps are shifted, not kept
The anonymiser SHALL shift every timestamp by one constant offset, so that the earliest timestamp in the output is 2020-01-01T00:00:00Z. Order and differences between timestamps SHALL be preserved.

#### Scenario: Earliest timestamp is the fixed epoch
- **WHEN** the anonymiser has produced an output
- **THEN** the smallest timestamp across `WORDS` and `LOOKUPS` equals 1577836800000

#### Scenario: Gaps are preserved
- **WHEN** two input lookups are 90 seconds apart
- **THEN** their output lookups are 90 seconds apart

### Requirement: Older snapshot for re-import tests
Given a share of lookups, the anonymiser SHALL also produce an older snapshot cut at the timestamp of the lookup at that rank. The snapshot contains only the lookups at or before that cutoff and the words and books they reference, and SHALL be a subset of the full output.

#### Scenario: Older snapshot is a subset
- **WHEN** the anonymiser produces a full output and an older snapshot
- **THEN** every row of the snapshot exists identically in the full output, and the full output has at least one lookup the snapshot lacks

### Requirement: Deterministic output
Running the anonymiser twice with the same input and options SHALL produce outputs with identical SQL dumps.

#### Scenario: Two runs agree
- **WHEN** the anonymiser runs twice on the same input with the same options
- **THEN** the SQL dumps of the two outputs are identical

### Requirement: Committed fixtures are anonymised
In the committed fixtures, every book id, GUID, ASIN and dictionary id SHALL be a `fixture-` placeholder or empty, no value SHALL start with `CR!`, and every profile id SHALL be a placeholder or empty. The repository SHALL NOT track the owner's original `vocab.db`.

#### Scenario: Committed fixtures pass the identifier scan
- **WHEN** the test suite scans `app/fixtures/vocab.db` and `app/fixtures/vocab-older.db`
- **THEN** every `BOOK_INFO.id`, `guid` and `asin`, every `DICT_INFO.id` and `asin`, every `LOOKUPS.book_key` and `dict_key`, and the book part of every `LOOKUPS.id` is empty or starts with `fixture-`; no text value starts with `CR!`; and every profile id is empty, null or `fixture-profile`

#### Scenario: Original file is ignored
- **WHEN** git checks whether `docs/vocab.db` is ignored
- **THEN** it reports that the path is ignored

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
