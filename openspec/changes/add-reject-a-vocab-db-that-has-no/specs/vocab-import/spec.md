## ADDED Requirements

### Requirement: A file without lookups is rejected
A file that is a SQLite database with the `WORDS`, `LOOKUPS` and `BOOK_INFO` tables but no rows in `LOOKUPS` SHALL cause the import to fail with the existing import error, with the code `no-lookups` and a message that says the file has no lookups. The check SHALL run after the SQLite and table checks. Rows in `WORDS` or `BOOK_INFO` SHALL NOT change this. Files that are not SQLite or lack a table SHALL keep their current errors.

#### Scenario: Empty lookups table is rejected
- **WHEN** a test-created SQLite file has `WORDS`, `LOOKUPS` and `BOOK_INFO` tables with no rows in any of them
- **THEN** parsing fails with the import error with the code `no-lookups`, and its message says the file has no lookups

#### Scenario: Words and books without lookups are still rejected
- **WHEN** a test-created SQLite file has rows in `WORDS` and `BOOK_INFO` but no rows in `LOOKUPS`
- **THEN** parsing fails with the import error with the code `no-lookups`, and its message says the file has no lookups

#### Scenario: Missing table error takes precedence over no lookups
- **WHEN** a test-created SQLite file has `WORDS` and `BOOK_INFO` tables but no `LOOKUPS` table
- **THEN** parsing fails with an error naming the missing `LOOKUPS` table, not an error about having no lookups

### Requirement: Re-import of a newer file without lookups fails
A newer file with no lookups SHALL fail when it is read for re-import, with the same error as a direct import. A newer file that has lookups, none of them new, SHALL still give a re-import result with no lookups, words or books.

#### Scenario: Newer file with no lookups fails when read
- **WHEN** a newer test-created file with the expected tables but no rows in `LOOKUPS` is read for re-import over the data parsed from `app/fixtures/vocab-older.db`
- **THEN** reading the newer file fails with the import error with the code `no-lookups`, and its message says the file has no lookups

#### Scenario: Newer file with only known lookups returns nothing new
- **WHEN** `app/fixtures/vocab-older.db` is re-imported over the data parsed from `app/fixtures/vocab.db`
- **THEN** no lookups, words or books are returned and no error is raised
