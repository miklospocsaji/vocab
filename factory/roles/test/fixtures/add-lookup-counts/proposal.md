# Proposal

## Why

Learners want to see which words they look up most often, so the practice queue can start with them. The importer already reads every lookup, but it does not count them per word.

## What Changes

- The importer reports, for each imported word, how many lookups reference it.
- Words that differ only in case are counted as one word.
- Out of scope: showing the counts in the app, and ordering the practice queue by them.

## Capabilities

### New Capabilities

### Modified Capabilities
- `vocab-import`: counting lookups per word.

## Impact

- `app/domain`: a new function that counts lookups per word.
- `app/contracts`: a `Lookup` type shared by the importer and the domain package.
