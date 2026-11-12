## ADDED Requirements

### Requirement: Usage sentences are cleaned
`cleanUsage(sentence)` SHALL remove soft hyphens (U+00AD), zero-width spaces (U+200B), zero-width non-joiners (U+200C), zero-width joiners (U+200D) and byte order marks (U+FEFF), replace every run of whitespace (including tabs, newlines and U+00A0) with one space, and trim the start and end. It SHALL change nothing else: case, punctuation and quotes stay as they are.

#### Scenario: Whitespace runs collapse and ends are trimmed
- **WHEN** `cleanUsage` is called with `"  The  cat\nsat. "`
- **THEN** it returns `"The cat sat."`

#### Scenario: Soft hyphen is removed
- **WHEN** `cleanUsage` is called with `"un­believable"`
- **THEN** it returns `"unbelievable"`

#### Scenario: Zero-width characters and byte order marks are removed
- **WHEN** `cleanUsage` is called with `"﻿a​b‌c‍d"`
- **THEN** it returns `"abcd"`

#### Scenario: Non-breaking space becomes a space
- **WHEN** `cleanUsage` is called with `"a b"`
- **THEN** it returns `"a b"`

#### Scenario: Empty sentence stays empty
- **WHEN** `cleanUsage` is called with `""`
- **THEN** it returns `""`

#### Scenario: Case, punctuation and quotes are kept
- **WHEN** `cleanUsage` is called with `"“Hello,” she said—'Yes!'"`
- **THEN** it returns the same string unchanged

### Requirement: Looked-up word is located in its sentence
`findWord(sentence, word)` SHALL return `{ start, end }` for the first case-insensitive, whole-word occurrence of `word` in `sentence`, so that `sentence.slice(start, end)` is the occurrence as written. A match is whole-word when the characters just before and after it, if any, are not Unicode letters or digits. It SHALL NOT clean the sentence itself.

#### Scenario: Match ignores case
- **WHEN** `findWord` is called with `"The Cat sat."` and `"cat"`
- **THEN** it returns `{ start: 4, end: 7 }`

#### Scenario: Match inside a longer word is skipped
- **WHEN** `findWord` is called with `"Concatenate the cat."` and `"cat"`
- **THEN** it returns `{ start: 16, end: 19 }`

#### Scenario: Accented word is matched with Unicode boundaries
- **WHEN** `findWord` is called with `"Il était là."` and `"était"`
- **THEN** it returns `{ start: 3, end: 8 }`

#### Scenario: Accented letter next to the match blocks it
- **WHEN** `findWord` is called with `"écat"` and `"cat"`
- **THEN** it returns `undefined`

### Requirement: Missing or blank word yields no match
`findWord(sentence, word)` SHALL return `undefined` when `sentence` has no whole-word occurrence of `word`, or when `word` is empty or only whitespace.

#### Scenario: No match returns undefined
- **WHEN** `findWord` is called with `"No match here."` and `"cat"`
- **THEN** it returns `undefined`

#### Scenario: Blank word returns undefined
- **WHEN** `findWord` is called with `"The cat sat."` and `""`, or with `"The cat sat."` and `"   "`
- **THEN** it returns `undefined` in both cases
