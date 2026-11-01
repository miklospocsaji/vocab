# Spec Delta

## Purpose

Practising a learner's imported words: which words are in the practice queue of a trajectory, how they are scheduled with FSRS, and how the learner marks words as known or ignored to take them out of practice.

## ADDED Requirements

### Requirement: Mark a word as known
The app SHALL let the learner mark a word as known, both from the word list and during a review. A known word SHALL NOT appear in the practice queue, and SHALL remain in the word list, shown as known.

#### Scenario: Known word leaves the practice queue
- **WHEN** the learner marks a word as known from the word list
- **THEN** the word no longer appears in that trajectory's practice queue

#### Scenario: Known word stays in the word list
- **WHEN** the learner has marked a word as known
- **THEN** the word list still shows the word, labelled as known

#### Scenario: Mark as known during a review
- **WHEN** the learner marks the word under review as known
- **THEN** the review moves on and the word does not appear again in that trajectory's practice queue

### Requirement: Un-mark a known word
The app SHALL let the learner remove the known mark from a word. An un-marked word SHALL return to the practice queue.

#### Scenario: Un-marked known word returns to practice
- **WHEN** the learner removes the known mark from a word
- **THEN** the word is no longer labelled as known in the word list and is again eligible for that trajectory's practice queue

### Requirement: Mark a word as ignored
The app SHALL let the learner mark a word as ignored, both from the word list and during a review. An ignored word SHALL NOT appear in the practice queue and SHALL be hidden from the word list by default.

#### Scenario: Ignored word leaves the practice queue
- **WHEN** the learner marks a word as ignored from the word list
- **THEN** the word no longer appears in that trajectory's practice queue

#### Scenario: Ignored word is hidden from the default word list
- **WHEN** the learner has marked a word as ignored and opens the word list without filters
- **THEN** the word is not shown

#### Scenario: Mark as ignored during a review
- **WHEN** the learner marks the word under review as ignored
- **THEN** the review moves on and the word does not appear again in that trajectory's practice queue

### Requirement: Show and restore ignored words
The word list SHALL offer a filter that shows ignored words, labelled as ignored. The learner SHALL be able to restore an ignored word, which removes the mark and returns the word to the practice queue and the default word list.

#### Scenario: Filter shows ignored words
- **WHEN** the learner turns on the ignored-words filter in the word list
- **THEN** the ignored words of the trajectory are shown, labelled as ignored

#### Scenario: Restored word returns to practice and the word list
- **WHEN** the learner restores an ignored word
- **THEN** the word appears in the default word list without a mark and is again eligible for that trajectory's practice queue

### Requirement: Marks are per trajectory
A mark SHALL apply to a word within one learning trajectory only. Marking a word in one trajectory SHALL NOT change the same word in any other trajectory of the learner.

#### Scenario: Mark does not affect another trajectory
- **WHEN** the same word exists in two of the learner's trajectories and the learner marks it as known or ignored in one of them
- **THEN** in the other trajectory the word is unmarked, shown in the default word list and eligible for the practice queue

### Requirement: Scheduling resumes after un-marking
When a known or ignored word returns to practice, its FSRS scheduling state SHALL be the state it had when it was marked, so its review history is not lost. A word whose due date passed while it was marked SHALL be due immediately.

#### Scenario: Review history survives a mark and un-mark
- **WHEN** a word with recorded reviews is marked as known and later un-marked
- **THEN** the word's scheduling state and review history equal those it had before it was marked

#### Scenario: Overdue word is due immediately after un-marking
- **WHEN** a word's due date passes while it is marked and the learner then un-marks it
- **THEN** the word is due in that trajectory's practice queue straight away
