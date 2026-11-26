## ADDED Requirements

### Requirement: Lookups are counted per hour of the day
Given an import result, lookups per hour SHALL return a list of 24 entries `{ hour, count }`, one for each hour 0 to 23 in ascending order, where count is the number of dated lookups whose timestamp falls in that hour. Hours with no lookups SHALL be present with count 0. Every lookup's hour SHALL be determined in the same time zone.

#### Scenario: All 24 hours are returned in order
- **WHEN** lookups per hour is computed for an import whose lookups all fall in hour 9
- **THEN** the result lists exactly 24 entries with hours 0 to 23 in ascending order, hour 9 has the number of lookups and every other hour has count 0

#### Scenario: Lookups are counted under the hour they fall in
- **WHEN** an import has two lookups falling in hour 7 and one lookup falling in hour 22
- **THEN** hour 7 has count 2, hour 22 has count 1, and the counts sum to 3

#### Scenario: Repeated lookups each count
- **WHEN** an import has three lookups of the same word in the same book, all falling in hour 14
- **THEN** hour 14 has count 3

### Requirement: Undated lookups are reported, not counted
A lookup whose timestamp is null SHALL NOT be counted under any hour. Lookups per hour SHALL also return the number of such undated lookups, so that the hourly counts plus the undated count equal the total number of lookups.

#### Scenario: Null timestamps are counted as undated
- **WHEN** an import has two lookups with a timestamp falling in hour 8 and one lookup with a null timestamp
- **THEN** hour 8 has count 2, the hourly counts sum to 2, and the undated count is 1

#### Scenario: Empty import gives zero counts
- **WHEN** lookups per hour is computed for an import with no lookups
- **THEN** the result lists 24 hours each with count 0 and the undated count is 0

### Requirement: Peak reading hours are the hours with the most lookups
Given the result of lookups per hour, peak reading hours SHALL return every hour whose count equals the highest count, in ascending order. When there are no dated lookups it SHALL return an empty list.

#### Scenario: Single peak hour is returned
- **WHEN** peak reading hours is computed for counts where hour 21 has 5 lookups and every other hour has fewer
- **THEN** the result is the list containing only hour 21

#### Scenario: Tied peak hours are all returned in order
- **WHEN** peak reading hours is computed for counts where hours 22 and 6 both have 4 lookups and every other hour has fewer
- **THEN** the result is hours 6 and 22, in that order

#### Scenario: No dated lookups gives no peak hours
- **WHEN** peak reading hours is computed for counts where every hour has count 0, whether or not there are undated lookups
- **THEN** the result is an empty list

### Requirement: Reading-hour functions are pure and exported
Lookups per hour and peak reading hours SHALL be exported from `app/domain/src/index.ts`, SHALL NOT modify their input, and SHALL return equal results for equal inputs. Parsing, import and re-import SHALL behave as before.

#### Scenario: Reading-hour functions are usable through the domain entry point
- **WHEN** a test imports both functions from the domain package entry point and applies them to the result of parsing `app/fixtures/vocab.db`
- **THEN** the hourly counts plus the undated count equal 733, the input is unchanged, and computing both again gives equal results
