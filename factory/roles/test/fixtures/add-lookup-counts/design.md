# Design

## Overview

A pure function in `app/domain` counts lookups per word. The importer calls it after parsing `vocab.db` and returns the counts with the imported words.

## Components

### `countLookups` (`app/domain/src/lookup-counts.ts`)

`countLookups(lookups: readonly Lookup[]): Map<string, number>` returns, for each word, the number of lookups of it. The key is the lookup's `word` in lower case (`toLowerCase()`), so "The" and "the" are counted together under "the". An empty input gives an empty map.

## Contracts

- `app/contracts/src/lookup.ts`: `Lookup { word: string; bookId: string; timestamp: number }`, exported from `app/contracts/src/index.ts`.

## Decisions that need an ADR

None.

## Risks

- Lower-casing with `toLowerCase()` ignores locale rules such as the Turkish dotless i. The fixtures are English and German, where it is correct.

## Open questions

None.
