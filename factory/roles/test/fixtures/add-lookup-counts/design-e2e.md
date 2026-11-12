# Design

## Overview

A pure function in `app/domain` counts lookups per word. It takes the words of the lookups the importer has read, so it needs no shared type. The importer, which does not exist yet, will call it with the word of each lookup.

## Components

### `countLookups` (`app/domain/src/lookup-counts.ts`)

`export function countLookups(words: readonly string[]): Map<string, number>` returns, for each word, the number of times it occurs in `words`. The key is the word in lower case (`toLowerCase()`), so "The" and "the" are counted together under "the", and no key keeps upper-case letters. An empty input gives an empty map. It does not change its input.

## Contracts

No changes in `app/contracts/`.

## Decisions that need an ADR

None.

## Risks

- Lower-casing with `toLowerCase()` ignores locale rules such as the Turkish dotless i. The fixtures are English and German, where it is correct.

## Open questions

None.
