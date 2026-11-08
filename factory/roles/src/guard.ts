/**
 * The `PreToolUse` guards on a role's file tools. The path guard, for Edit, Write and
 * NotebookEdit, denies any target that, resolved against the worktree with symlinks followed,
 * falls outside the role's writable globs or outside the worktree. The read guard does the
 * same for Read, Grep and Glob against the worktree alone. Allowed calls are left to the SDK
 * permission rules.
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
  const deny = (why: string): HookJSONOutput => denial(`role ${role}: ${why}. Writable paths: ${allowed}`);

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

/**
 * Glob patterns that can leave their search root: an absolute or `~` start, or a `..` segment,
 * also as an alternative inside braces or an extglob. A name that only contains dots is fine.
 */
const GLOB_LEAVES_ROOT = [/(?:^|[{,(|])[/~]/, /(?:^|[{,(|/])\.\.(?:$|[},)|/])/];

export interface ReadGuardOptions {
  /** The role name, used in the deny reason. */
  role: string;
  /** The work item's worktree; targets resolve against it. */
  worktree: string;
}

export function createReadGuard(options: ReadGuardOptions): HookCallback {
  const { role, worktree } = options;
  const deny = (why: string): HookJSONOutput => denial(`role ${role}: ${why}. Reads are limited to the worktree`);

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    if (input.tool_name === "Glob") {
      const pattern = toolInput["pattern"];
      if (typeof pattern !== "string") return deny("Glob has no pattern");
      if (GLOB_LEAVES_ROOT.some((form) => form.test(pattern))) return deny(`the pattern ${pattern} can leave the worktree`);
    }

    // Grep and Glob search the session's cwd, the worktree, when they have no path.
    const target = input.tool_name === "Read" ? toolInput["file_path"] : (toolInput["path"] ?? ".");
    if (typeof target !== "string" || target === "") return deny(`${input.tool_name} has no target path`);
    // The tools expand a leading ~ themselves, so it would otherwise resolve as a folder in the worktree.
    if (target.startsWith("~")) return deny(`${target} is outside the worktree`);

    const root = await realpath(worktree);
    const lexical = resolve(root, target);
    if (!isWithin(root, lexical)) return deny(`${target} is outside the worktree`);

    let real: string | undefined;
    try {
      real = await realTarget(lexical);
    } catch {
      // A symlink loop or a file used as a directory: what cannot be checked is not read.
      return deny(`${target} cannot be resolved`);
    }
    if (real === undefined) return deny(`${target} is a dangling symlink`);
    if (!isWithin(root, real)) return deny(`${target} resolves outside the worktree`);
    return {};
  };
}

function denial(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** True if `path` is the worktree root or below it; both absolute and normalised. */
function isWithin(root: string, path: string): boolean {
  return path === root || isInside(root, path);
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
