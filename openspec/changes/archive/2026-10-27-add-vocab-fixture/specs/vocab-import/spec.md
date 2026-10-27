## ADDED Requirements

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
