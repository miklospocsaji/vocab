# Tasks

- [ ] 1.1 Parse a vocab.db into books, words and lookups
  - Scenarios: Fixture parses to its books, words and lookups; Older fixture parses to its lookups; Fields are copied as stored; Parsing leaves the file unchanged; Repeated lookups are all kept; Lookup with a missing word is rejected; Lookup with a missing book is rejected; Non-SQLite file is rejected; Missing table is rejected; Lists are sorted by id
  - Files: app/domain/src/vocab-import/parse.ts, app/domain/src/index.ts
  - Tests: app/domain/test/parse.test.ts
- [ ] 1.2 Re-import returns only new data
  - Scenarios: Re-import after the older snapshot adds the new lookups; Re-importing the same file adds nothing; Only unknown words and books are returned
  - Files: app/domain/src/vocab-import/reimport.ts, app/domain/src/index.ts
  - Tests: app/domain/test/reimport.test.ts
