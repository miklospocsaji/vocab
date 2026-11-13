## ADDED Requirements

### Requirement: Gates check only the app's code
The gates SHALL typecheck and lint only the app (the worktree's `typecheck:app` and `lint:app` scripts), never the factory's or the infrastructure's code. A whole-repository lint does not fit the build task's memory, and an app task has no business with factory code.

#### Scenario: Gates check only the app's code
- **WHEN** the green gates run in a worktree whose app passes typecheck and lint and whose factory code has a lint error and a type error
- **THEN** the `typecheck` and `lint` checks pass, and so do the gates
