## ADDED Requirements

### Requirement: Lookups are counted per calendar day
Given a `VocabImport`, the domain SHALL return a list of `{ day, count }` entries, one for each calendar day that has at least one lookup. `day` is the UTC calendar day of the lookup's `timestamp` as a `YYYY-MM-DD` string, and `count` is the number of lookups on that day.

#### Scenario: Lookups on the same day are counted together
- **WHEN** an import holds three lookups with timestamps at 2020-01-01T00:00:00Z, 2020-01-01T23:59:59.999Z and 2020-01-02T00:00:00Z
- **THEN** the result is `[{ day: "2020-01-01", count: 2 }, { day: "2020-01-02", count: 1 }]`

#### Scenario: Days without lookups are left out
- **WHEN** an import holds one lookup on 2020-01-01 and one on 2020-01-05, both in UTC
- **THEN** the result has exactly two entries, for `2020-01-01` and `2020-01-05`

#### Scenario: Per-day counts add up to the dated lookups of the full fixture
- **WHEN** the data parsed from `app/fixtures/vocab.db` is counted per day
- **THEN** every `day` matches `YYYY-MM-DD`, every `count` is at least 1, and the counts plus the undated lookup count total 733

### Requirement: Per-day counts are sorted oldest first
The per-day result SHALL be sorted by `day` in ascending order, whatever the order of the lookups in the input.

#### Scenario: Out-of-order lookups give days oldest first
- **WHEN** an import lists a lookup on 2020-03-01 before lookups on 2020-01-15 and 2020-02-10
- **THEN** the result's days are `2020-01-15`, `2020-02-10`, `2020-03-01`, in that order

### Requirement: Undated lookups are reported, not counted under a day
A lookup whose `timestamp` is `null` SHALL NOT count under any day, and the result SHALL report how many such undated lookups the import holds.

#### Scenario: Null timestamps are reported as undated
- **WHEN** an import holds two lookups with a `null` timestamp and one lookup on 2020-01-01
- **THEN** the result's days are `[{ day: "2020-01-01", count: 1 }]` and its undated count is 2

### Requirement: An import without lookups gives an empty count
An import with no lookups SHALL give an empty list of days and an undated count of zero.

#### Scenario: Empty import gives no days and zero undated
- **WHEN** an import with no lookups is counted per day
- **THEN** the result has an empty list of days and an undated count of 0

### Requirement: Per-day counting is pure and exported
The per-day count SHALL be exported from `app/domain/src/index.ts`. It SHALL NOT modify its input and SHALL return equal results for equal inputs.

#### Scenario: Counting through the entry point leaves the import unchanged
- **WHEN** a test imports the per-day count from the domain package entry point and runs it twice on the same import
- **THEN** both results are equal and the import is deep-equal to a copy taken before counting
