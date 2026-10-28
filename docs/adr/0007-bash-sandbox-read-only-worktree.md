# 0007 Bash sandbox: read-only worktree

Status: accepted (2026-10-27)

## Context

Every role with Bash runs in the Agent SDK `sandbox`, with filesystem writes limited to the role's writable paths (brief, section 4; the `roles` spec). Bash can write files, so the path guard on Edit, Write and NotebookEdit does not cover it. Role writable paths are globs such as `openspec/changes/<id>/specs/**/spec.md`.

The task 1.3 spike, with SDK 0.3.310 on Linux and bwrap, found:
- The sandbox makes the working directory writable by default.
- `allowWrite` only adds writable paths.
- `denyWrite` accepts exact paths, not globs.
- A `denyWrite` on a directory beats an `allowWrite` on anything inside it.

So the sandbox cannot express "writable only where these globs match". Denying every sibling of the allowed paths fails as well, because a file created under a new name is not covered.

## Decision

- For every role, the runner sets `sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [<worktree>] } }`. Bash cannot write anywhere in the worktree. Outside the worktree it cannot write either, apart from the sandbox's own temp area.
- Roles change files only through Edit and Write, which the `PreToolUse` path guard checks against their globs.
- `allowUnsandboxedCommands: false` stops a model from asking to run a command outside the sandbox. `failIfUnavailable: true` makes a host without sandbox support fail the attempt instead of running unconfined.

This satisfies the `roles` requirement, because Bash writes are limited to a subset of the role's paths (here, none).

## Alternatives

- **Read-only bind mount of the worktree except the writable paths** (the fallback in the `add-role-runner` design): precise, but it means managing mounts in the runner, and the SDK sandbox already gives a read-only worktree.
- **A computed `denyWrite` list of every sibling of the allowed paths:** leaks new files at non-allowed levels.
- **No Bash for writing roles:** too strict for M3, where the test author and implementer run tests.

## Consequences

- The proposal author is unaffected: its Bash runs read-only `openspec` commands.
- M3 roles that run `pnpm test` through Bash may need to write tool caches (Vite and Vitest caches, coverage). Before M3, decide where those caches go: outside the worktree through env vars, a `denyWrite`-free cache directory, or running test commands only in the deterministic gates. Revisit this ADR then.
- The live test "Bash cannot write outside the role's paths" checks this boundary, and runs again on every SDK upgrade.
