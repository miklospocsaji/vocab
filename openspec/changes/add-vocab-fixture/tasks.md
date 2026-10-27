# Tasks

## 1. Package and tests first

- [ ] 1.1 Create `app/fixtures` package (`@vocab/fixtures`) with typecheck script and Vitest project
- [ ] 1.2 Test helper that builds a synthetic Kindle-shaped `vocab.db` (five books, fake `CR!` ids and ASINs, repeated lookups)
- [ ] 1.3 Failing tests for the anonymiser on the synthetic input (Scenarios: Schema is unchanged, No original identifier survives, References still resolve, Only selected books are kept, Sentences are kept verbatim, Earliest timestamp is the fixed epoch, Gaps are preserved, Older snapshot is a subset, Two runs agree)
- [ ] 1.4 Failing tests on the committed fixtures (Scenarios: Committed fixtures pass the identifier scan, Original file is ignored)

## 2. Anonymiser

- [ ] 2.1 `app/fixtures/scripts/anonymise-vocab-db.ts` with options `--in`, `--out`, `--older-out`, `--book <id>` (repeatable), `--cutoff`; runs with plain `node`
- [ ] 2.2 Generate `app/fixtures/vocab.db` and `app/fixtures/vocab-older.db` from the owner's file with the owner-selected books; document the exact command in `app/fixtures/README.md`
