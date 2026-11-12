# 0012 Role prompts outside `.claude/agents`

Status: accepted (2026-11-09; owner decision of 2026-11-08)

## Context

Until M3 a role was a config in `factory/roles/<role>.yaml` and a prompt in `.claude/agents/<role>.md`, with Claude Code subagent frontmatter (`name`, `description`, `tools`, `model`) that the runner stripped (brief, section 4).

Claude Code registers every `.claude/agents/*.md` as a subagent. Any local session in this repository could then start a factory role, by hand or by auto-delegation, with none of the runner's guards: no path guard, no read guard, no environment allowlist, no budget, and tools and model taken from the frontmatter rather than the yaml. For the proposal author that was a nuisance. For M3's implementer, which has Bash, it would be a role that runs agent-written code outside the build container (ADR 0011).

The frontmatter also repeated the yaml's tools and model, so the two could drift.

## Decision

- Each role's prompt lives at `factory/roles/<role>.md`, next to its config, with no frontmatter (option A, owner, 2026-11-08). `loadRole` reads it from there.
- `.claude/agents/` is removed. The proposal author's prompt moves without its frontmatter.
- The yaml config is the only source for a role's tools, pre-approved calls, model and limits.
- A unit test checks that `.claude/agents/` holds no file, and that every `factory/roles/<role>.md` starts without a frontmatter block (scenario "No role is registered as an agent").
- The worker image copies the prompts with `factory/`, and no longer copies `.claude/agents` (ADR 0010).

## Alternatives

- **A. Move the prompts next to their configs, with no frontmatter (chosen).** Claude Code never loads them.
- **B. Keep `.claude/agents/<role>.md` without frontmatter.** It relies on Claude Code skipping such files, which is not a documented promise, and the folder still says "agents".
- **C. Keep them as subagents.** Any local session could run the implementer with no guards or budget.

## Consequences

- A local Claude Code session no longer lists `proposal-author` as an agent. Hand-running a stage goes through the OpenSpec workflow (`/opsx:*`) or `pnpm factory`, which use the runner.
- `stripFrontmatter` stays in `loadRole`, so a prompt that gains frontmatter by mistake still yields a clean system prompt, and the scenario test reports it.
- Brief principle 9 ("role prompts, skills, agent definitions, hooks and evals are versioned files") still holds; the prompts are versioned under `factory/roles/`.
