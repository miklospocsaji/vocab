# 0007 Bash sandbox: read-only worktree

Status: accepted (2026-10-27); amended 2026-10-31 (`autoAllowBashIfSandboxed`) and 2026-11-04 (containers)

## Context

Every role with Bash runs in the Agent SDK `sandbox`, with filesystem writes limited to the role's writable paths (brief, section 4; the `roles` spec). Bash can write files, so the path guard on Edit, Write and NotebookEdit does not cover it. Role writable paths are globs such as `openspec/changes/<id>/specs/**/spec.md`.

The task 1.3 spike, with SDK 0.3.310 on Linux and bwrap, found:
- The sandbox makes the working directory writable by default.
- `allowWrite` only adds writable paths.
- `denyWrite` accepts exact paths, not globs.
- A `denyWrite` on a directory beats an `allowWrite` on anything inside it.

So the sandbox cannot express "writable only where these globs match". Denying every sibling of the allowed paths fails as well, because a file created under a new name is not covered.

The live boundary test of task 7.2 (2026-10-31) then found one more default: `sandbox.autoAllowBashIfSandboxed` is `true` unless set. With it, every sandboxed Bash command is approved automatically and the role's `Bash(...)` rules in `allowedTools` are never consulted, even under `permissionMode: "dontAsk"`. A role allowed only `openspec` ran `curl https://example.com`. Only the sandbox's network proxy stopped it.

## Decision

- For every role, the runner sets `sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { denyWrite: [<worktree>] } }`. Bash cannot write anywhere in the worktree. Outside the worktree it cannot write either, apart from the sandbox's own temp area.
- Roles change files only through Edit and Write, which the `PreToolUse` path guard checks against their globs.
- `autoAllowBashIfSandboxed: false` keeps the role's Bash allowlist in charge: the sandbox confines the commands the allowlist approves, and never approves commands itself.
- `allowUnsandboxedCommands: false` stops a model from asking to run a command outside the sandbox. `failIfUnavailable: true` makes every Bash command fail on a host without sandbox support, instead of running unconfined. The session itself carries on, and can still end in `success` (corrected 2026-11-04; this ADR first said the attempt fails). That holds when `bubblewrap` and `socat` are installed and the sandbox cannot create its namespaces. When they are missing, the SDK refuses to start the session at all, for every role, with or without Bash (found 2026-11-06, `add-factory-worker` task 1.16). So the `factory-worker` image installs them (ADR 0010).

This satisfies the `roles` requirement, because Bash writes are limited to a subset of the role's paths (here, none).

## Alternatives

- **Read-only bind mount of the worktree except the writable paths** (the fallback in the `add-role-runner` design): precise, but it means managing mounts in the runner, and the SDK sandbox already gives a read-only worktree.
- **A computed `denyWrite` list of every sibling of the allowed paths:** leaks new files at non-allowed levels.
- **No Bash for writing roles:** too strict for M3, where the test author and implementer run tests.

## Consequences

- M3 roles that run `pnpm test` through Bash may need to write tool caches (Vite and Vitest caches, coverage). Before M3, decide where those caches go: outside the worktree through env vars, a `denyWrite`-free cache directory, or running test commands only in the deterministic gates. Revisit this ADR then.
- The live tests "Bash cannot write outside the role's paths" and "Non-allowlisted command is denied" check these boundaries, and run again on every SDK upgrade. A unit test pins `autoAllowBashIfSandboxed: false` in the runner's options.
- An SDK upgrade can change sandbox defaults. Set every sandbox option the boundaries depend on explicitly, instead of relying on a default.

## Amendment 2026-11-04: containers

The M2 spike (`add-factory-worker` design, SDK 0.3.310) ran the sandbox in a container, as a non-root user with no added capabilities:
- Under Docker's defaults, bubblewrap cannot start: seccomp and AppArmor both block it, and `enableWeakerNestedSandbox` does not help.
- It works only with seccomp and AppArmor both unconfined and `enableWeakerNestedSandbox` on, which leaves the host's `/proc` readable by sandboxed commands.
- Fargate does not allow relaxing seccomp, so it very likely cannot run there. That has not been tested on Fargate yet.

Decision (owner, 2026-11-04): the proposal author has no Bash, locally or in the worker. The runner validates its change after the session. The sandbox options stay in the runner for any role with Bash, and on a host without sandbox support those roles' commands fail.

M3's test author and implementer need Bash, so M3 must decide how they run code. The cache question above is part of that decision.
