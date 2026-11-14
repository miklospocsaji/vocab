# Tasks

- [x] 1.1 Parse a vocab.db into books, words and lookups
  - Files: app/domain/src/vocab-import/errors.ts, app/domain/src/vocab-import/parse.ts
  - Tests: app/domain/test/parse.test.ts
  - Scenarios: Full fixture parses to its known counts; Older fixture parses to its known lookup count; Fields are carried over as stored; Parsing leaves the file unchanged; Repeated lookups are all kept; Lookup with a missing word fails; Lookup with a missing book fails; Non-SQLite file is rejected; Missing table is rejected; Lists are sorted by id

- [x] 1.2 Re-import returns only new data
  - Files: app/domain/src/vocab-import/reimport.ts
  - Tests: app/domain/test/reimport.test.ts
  - Scenarios: Newer file adds only new lookups; Re-importing the same file adds nothing; Only unknown words and books are returned; Older plus new equals newer

- [ ] 1.3 Export the importer from the domain entry point
  - Files: app/domain/src/index.ts
  - Tests: app/domain/test/entry-point.test.ts
  - Scenarios: Importer is usable through the package entry points
