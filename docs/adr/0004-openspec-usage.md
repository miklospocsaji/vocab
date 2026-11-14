# 0004 OpenSpec capabilities

Status: accepted (2026-10-27; owner decisions of 2026-10-26 and 2026-10-27; split by content on 2026-11-14, when the repository became app-only)

## Context

OpenSpec is the format for the app's intent, design and tasks. Requirements live in `openspec/specs/<capability>/spec.md`, so the set of capabilities shapes every change.

## Decision

- The capabilities are `vocab-import`, `trajectories`, `enrichment`, `practice` and `auth`.
- New capabilities need an owner decision.

## Alternatives

- Letting each change name its own capabilities: specs would fragment into overlapping folders.

## Consequences

- A proposal names its capabilities from this list; `openspec/config.yaml` repeats it for every OpenSpec session.
