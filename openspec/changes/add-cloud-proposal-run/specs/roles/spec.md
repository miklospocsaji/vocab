## ADDED Requirements

### Requirement: Role boundaries hold in Fargate
The role boundaries, including the Bash sandbox with `failIfUnavailable`, SHALL hold in the `factory-worker` image on Fargate, as they do locally.

#### Scenario: Boundaries hold in Fargate
- **WHEN** the boundary tests ("Non-allowlisted command is denied", "Bash cannot write outside the role's paths", "Write outside the allowed paths is denied", "WebFetch outside GitHub is denied", "Reading a process environment is denied") run as a `factory-worker` Fargate task in api-key mode
- **THEN** they pass
