## ADDED Requirements

### Requirement: Role boundaries hold in Fargate
The role boundaries SHALL hold in the `factory-worker` image on Fargate, as they do locally.

#### Scenario: Boundaries hold in Fargate
- **WHEN** the boundary tests ("Write outside the allowed paths is denied", "WebFetch outside GitHub is denied", "Reading a process environment is denied", "Proposal author cannot run commands") run as a `factory-worker` Fargate task in api-key mode
- **THEN** they pass
