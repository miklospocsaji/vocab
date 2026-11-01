/**
 * The `PreToolUse` path guard for Edit, Write and NotebookEdit. It denies any target that,
 * resolved against the worktree with symlinks followed, falls outside the role's writable
 * globs or outside the worktree. Allowed calls are left to the SDK permission rules.
 */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { minimatch } from "minimatch";

export interface PathGuardOptions {
  /** The role name, used in the deny reason. */
  role: string;
  /** The work item's worktree; targets resolve against it. */
  worktree: string;
  /** Globs relative to the worktree, with `{changeId}` already filled in. */
  writable: string[];
}

export function createPathGuard(options: PathGuardOptions): HookCallback {
  const { role, worktree, writable } = options;
  const allowed = writable.length > 0 ? writable.join(", ") : "none (read-only role)";
  const deny = (why: string): HookJSONOutput => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `role ${role}: ${why}. Writable paths: ${allowed}`,
    },
  });

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const target = input.tool_name === "NotebookEdit" ? toolInput["notebook_path"] : toolInput["file_path"];
    if (typeof target !== "string" || target === "") return deny(`${input.tool_name} has no target path`);

    const root = await realpath(worktree);
    const lexical = resolve(root, target);
    if (!isInside(root, lexical)) return deny(`${target} is outside the worktree`);

    const real = await realTarget(lexical);
    if (real === undefined) return deny(`${target} is a dangling symlink`);
    if (!isInside(root, real)) return deny(`${target} resolves outside the worktree`);

    const path = relative(root, real).split(sep).join("/");
    if (!writable.some((glob) => minimatch(path, glob, { dot: true }))) {
      return deny(`${target} is outside the role's writable paths`);
    }
    return {};
  };
}

/** True if `path` is strictly below `root`; both absolute and normalised. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The path with symlinks followed: the realpath of its nearest existing ancestor (or of the
 * path itself), joined with the segments that do not exist yet. Undefined for a dangling
 * symlink, whose eventual target cannot be checked.
 */
async function realTarget(path: string): Promise<string | undefined> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
  try {
    return join(await realpath(current), ...missing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
