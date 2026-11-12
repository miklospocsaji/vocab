## ADDED Requirements

### Requirement: Import
The importer SHALL read every book and SHALL add only new lookups on a re-import.

#### Scenario: Import reads every book
- **WHEN** a vocab.db with three books is imported
- **THEN** three books are stored

#### Scenario: Re-import adds only new lookups
- **WHEN** the same vocab.db is imported twice
- **THEN** the second import adds no lookups

#### Scenario: Import keeps the lookup's sentence
- **WHEN** a lookup is imported
- **THEN** its sentence is stored with it
