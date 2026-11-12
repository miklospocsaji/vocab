## ADDED Requirements

### Requirement: Build boundaries hold in Fargate
The build container's boundaries SHALL hold as a Fargate task of the build task definition, as they do in Docker.

#### Scenario: Build boundaries hold in Fargate
- **WHEN** the build boundary tests ("Non-allowlisted command is denied", "Build container holds only the model credential", "Build container refuses factory credentials") run as a Fargate task of the build task definition in api-key mode
- **THEN** they pass
