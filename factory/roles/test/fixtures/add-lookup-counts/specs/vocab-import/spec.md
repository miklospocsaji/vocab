## ADDED Requirements

### Requirement: Lookups are counted per word
The importer SHALL report, for each imported word, the number of lookups that reference it. Words that differ only in letter case SHALL be counted as one word, under the word in lower case.

#### Scenario: Lookups of one word are counted
- **WHEN** a file with three lookups of "serendipity" and one of "quixotic" is imported
- **THEN** the counts are 3 for "serendipity" and 1 for "quixotic"

#### Scenario: Words differing only in case are counted together
- **WHEN** a file with lookups of "The" and "the" is imported
- **THEN** the count for "the" is 2, and there is no separate count for "The"
