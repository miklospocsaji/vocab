## ADDED Requirements

### Requirement: Lookups are counted per language
Given a `VocabImport`, the domain SHALL return a list of `{ language, count }` entries, one per language that has at least one lookup, where a lookup's language is the `language` of the word its word id points to and `count` is the number of such lookups.

#### Scenario: Lookups are counted under their word's language
- **WHEN** an import holds three lookups of `en` words and one lookup of a `de` word
- **THEN** the result contains `{ language: "en", count: 3 }` and `{ language: "de", count: 1 }` and no other entries

#### Scenario: Counts add up to the number of lookups
- **WHEN** the data parsed from `app/fixtures/vocab.db` is counted
- **THEN** the sum of all counts is 733

#### Scenario: Import without lookups gives an empty list
- **WHEN** an import with words and books but no lookups is counted
- **THEN** the result is an empty list

### Requirement: Language counts are sorted by count then language
The per-language counts SHALL be sorted by count, highest first, and entries with equal counts SHALL be sorted by language in ascending order.

#### Scenario: Higher counts come first
- **WHEN** an import holds one `de` lookup and two `en` lookups
- **THEN** the result is `[{ language: "en", count: 2 }, { language: "de", count: 1 }]`

#### Scenario: Ties are ordered by language ascending
- **WHEN** an import holds two `fr` lookups and two `de` lookups
- **THEN** the result is `[{ language: "de", count: 2 }, { language: "fr", count: 2 }]`

### Requirement: Lookups without a known language are counted under null
Lookups whose word has a `null` language, and lookups whose word id matches no word in the import, SHALL be counted together under a `null` language entry. They SHALL NOT be dropped, merged into another language, or cause an error.

#### Scenario: Word with null language is counted under null
- **WHEN** an import holds one lookup of a word whose language is `null` and one lookup of an `en` word
- **THEN** the result contains `{ language: null, count: 1 }` and `{ language: "en", count: 1 }`

#### Scenario: Lookup of a missing word is counted under null
- **WHEN** an import holds a lookup whose word id matches no word in the import
- **THEN** counting does not throw and the result contains `{ language: null, count: 1 }`

#### Scenario: Null-language and missing-word lookups share one entry
- **WHEN** an import holds one lookup of a word whose language is `null` and one lookup whose word id matches no word
- **THEN** the result is `[{ language: null, count: 2 }]`

### Requirement: Language counting is pure and exported
Counting lookups per language SHALL NOT modify its input, SHALL return equal results for equal inputs, and SHALL be exported from `app/domain/src/index.ts`.

#### Scenario: Counting leaves the import unchanged
- **WHEN** the data parsed from `app/fixtures/vocab.db` is counted twice
- **THEN** both results are equal and the import is deeply equal to a copy taken before counting

#### Scenario: Counting is usable through the domain entry point
- **WHEN** a test imports the counting function from the domain package entry point and applies it to the data parsed from `app/fixtures/vocab.db`
- **THEN** it returns a non-empty list of `{ language, count }` entries
