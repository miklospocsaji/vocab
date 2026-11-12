## ADDED Requirements

### Requirement: Addition
The demo SHALL add two numbers.

#### Scenario: Adds two numbers
- **WHEN** it adds 1 and 2
- **THEN** the result is 3

### Requirement: Subtraction
The demo SHALL subtract two finite numbers and SHALL refuse any other.

#### Scenario: Subtracts two numbers
- **WHEN** it subtracts 1 from 3
- **THEN** the result is 2

#### Scenario: Refuses non-finite numbers
- **WHEN** it subtracts infinity from 1
- **THEN** it throws an error naming finite numbers
