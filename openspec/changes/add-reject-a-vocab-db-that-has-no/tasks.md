# Tasks

- [x] 1.1 Reject a vocab.db with no lookups
  - Scenarios: Empty lookups table is rejected; Words and books without lookups are still rejected; Missing table error takes precedence over no lookups; Newer file with no lookups fails when read; Newer file with only known lookups returns nothing new
  - Files: app/domain/src/vocab-import/parse.ts
  - Tests: app/domain/test/parse.test.ts, app/domain/test/reimport.test.ts
