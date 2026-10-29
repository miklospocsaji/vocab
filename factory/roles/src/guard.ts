/**
 * The `PreToolUse` path guard for Edit, Write and NotebookEdit. It denies any target that,
 * resolved against the worktree with symlinks followed, falls outside the role's writable
 * globs or outside the worktree. Allowed calls are left to the SDK permission rules.
 */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export interface PathGuardOptions {
  /** The role name, used in the deny reason. */
  role: string;
  /** The work item's worktree; targets resolve against it. */
  worktree: string;
  /** Globs relative to the worktree, with `{changeId}` already filled in. */
  writable: string[];
}

export function createPathGuard(options: PathGuardOptions): HookCallback {
  throw new Error(`createPathGuard is not implemented yet (add-role-runner task 3.2), role ${options.role}`);
}
