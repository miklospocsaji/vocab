# Tasks

- [ ] 1.1 Parse a Kindle vocab.db
  - Scenarios: Full fixture parses to its known counts; Older fixture parses to its known lookup count; Fields are read as stored; Source file is left unchanged; Repeated lookups of a word in one book are kept; Lookup with a missing word is reported; Lookup with a missing book is reported; Non-SQLite file is rejected; Missing table is named; Lists are sorted by id
  - Files: app/domain/src/vocab-import/parse.ts, app/domain/src/index.ts
  - Tests: app/domain/test/parse.test.ts
- [ ] 1.2 Re-import only new data
  - Scenarios: Newer file adds only its new lookups; Re-importing the same file adds nothing; Only unknown words and books are returned
  - Files: app/domain/src/vocab-import/reimport.ts, app/domain/src/index.ts
  - Tests: app/domain/test/reimport.test.ts
