# Spec Delta

## ADDED Requirements

### Requirement: Re-import preserves word marks
Re-importing a newer `vocab.db` into a trajectory SHALL NOT change any word's known or ignored mark. New lookups of a marked word SHALL still be stored with their usage sentence, and the word SHALL keep its mark.

#### Scenario: Re-import keeps a known mark
- **WHEN** a word is marked as known and a newer `vocab.db` containing that word is imported into the same trajectory
- **THEN** the word is still marked as known after the import

#### Scenario: New lookups of an ignored word are stored
- **WHEN** a word is marked as ignored and a newer `vocab.db` with a new lookup of that word is imported into the same trajectory
- **THEN** the new lookup and its usage sentence are stored for the word, and the word is still marked as ignored
