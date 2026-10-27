# 0004 OpenSpec usage and capabilities

Status: accepted (2026-10-27; owner decisions of 2026-10-26 and 2026-10-27)

## Context

OpenSpec is the format for intent, design and tasks, for the app and for the factory itself. OpenSpec 1.15 differs from what the brief first assumed:
- `openspec init` writes `openspec/config.yaml` (context and per-artifact rules) instead of a project conventions file.
- Each change has a `.openspec.yaml` metadata file, and `--strict` rejects unknown keys unless they are prefixed with `x-`.
- A change must contain at least one delta unless it sets `skip_specs: true`.
- `init --tools claude` also writes OpenSpec skills to `.claude/skills/` and slash commands to `.claude/commands/opsx/`.

## Decision

- Capabilities:
  - App: `vocab-import`, `trajectories`, `enrichment`, `practice`, `auth`.
  - Factory: `orchestration`, `roles`, `gates`.
  - New capabilities need an owner decision.
- Changes are scoped per milestone. A change holds only what its milestone builds and is archived (`openspec archive <id> --yes`) when that milestone exits, so `openspec/specs/` never describes behaviour that does not exist yet.
- The complexity tag lives in `.openspec.yaml` as `x-complexity: small | medium | large`.
- Tests name the scenario they prove by putting the exact scenario title in the test name, for example `it("Scenario: Re-import adds only new lookups", …)`. Scenario titles are unique within a change. The coverage gate (M3) matches on this.
- The OpenSpec CLI is a pinned dev dependency; `pnpm openspec …` is the only way scripts and CI call it.
- The OpenSpec skills and commands from `init` stay in the repo for hand-running stages locally. Factory roles see only the skills listed in their role config.

## Alternatives

- Full-target specs up front, archived when everything is built: the whole picture is visible early, but changes are long-lived and specs say nothing true for months.
- The complexity tag in `proposal.md` frontmatter: OpenSpec does not parse it, so a typo would go unnoticed. `x-` keys are at least tolerated by strict validation, and the runner validates the value with zod.

## Consequences

- At every milestone exit, `openspec/specs/` matches what exists.
- The owner approves the next milestone's factory changes at the end of the current one.
- OpenSpec upgrades may change validation rules; they go through a normal PR with gates.
