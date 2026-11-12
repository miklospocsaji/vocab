/**
 * The diff check of a role that can write (ADR 0011): every path that differs from the
 * session's starting commit, committed, staged, unstaged or untracked, is checked with the role's
 * matcher (`isWritable`, shared with the path guard). The starting commit is given by the caller,
 * never read from the clone's HEAD, so a commit made during the session hides nothing.
 * Git-ignored files never appear, so caches under `node_modules/` pass. In the build container
 * this is fast feedback; the worker's re-check of the patch is the boundary (add-build-loop).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isWritable } from "./guard.ts";

const run = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

export interface DiffCheckResult {
  passed: boolean;
  /** Worktree-relative paths outside the role's globs, sorted. */
  outside: string[];
}

interface Change {
  /** `A`, `M`, `D` or `T` (`--no-renames`), or `?` for an untracked file. */
  status: string;
  path: string;
}

/**
 * Checks the worktree against `baseCommit`. `writable` are the role's globs from `writableFor`.
 * `newOnly` are the task's stubs: they are writable only as new files, so one that existed at
 * `baseCommit` and changed fails the check.
 */
export async function diffCheck(worktree: string, baseCommit: string, writable: readonly string[], newOnly: readonly string[] = []): Promise<DiffCheckResult> {
  const stubs = new Set(newOnly);
  const outside = new Set<string>();
  for (const { status, path } of await changes(worktree, baseCommit)) {
    const added = status === "A" || status === "?";
    if (!isWritable(path, writable) || (stubs.has(path) && !added)) outside.add(path);
  }
  const sorted = [...outside].sort();
  return { passed: sorted.length === 0, outside: sorted };
}

/**
 * The patch from `baseCommit` to the worktree, binary-safe, built the way the check sees it:
 * untracked files are added with `--intent-to-add` first, so the patch holds them too.
 */
export async function diffPatch(worktree: string, baseCommit: string): Promise<string> {
  await verifyCommit(worktree, baseCommit);
  const untracked = await untrackedFiles(worktree);
  if (untracked.length > 0) await git(worktree, ["add", "--intent-to-add", "--", ...untracked]);
  return git(worktree, ["diff", "--binary", "--no-renames", "--no-color", "--no-ext-diff", baseCommit, "--"]);
}

async function changes(worktree: string, baseCommit: string): Promise<Change[]> {
  await verifyCommit(worktree, baseCommit);
  const diff = await git(worktree, ["diff", "--name-status", "-z", "--no-renames", baseCommit, "--"]);
  const fields = diff.split("\0").filter((field) => field !== "");
  const found: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) found.push({ status: fields[i] ?? "", path: fields[i + 1] ?? "" });
  for (const path of await untrackedFiles(worktree)) found.push({ status: "?", path });
  return found;
}

async function untrackedFiles(worktree: string): Promise<string[]> {
  const listed = await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return listed.split("\0").filter((path) => path !== "");
}

/** Throws unless `baseCommit` names a commit of the repository. */
async function verifyCommit(worktree: string, baseCommit: string): Promise<void> {
  await git(worktree, ["cat-file", "-e", `${baseCommit}^{commit}`]);
}

async function git(worktree: string, args: string[]): Promise<string> {
  // No pager, no colour, quoted paths off: output is parsed, never shown.
  const { stdout } = await run("git", ["-c", "core.quotePath=false", ...args], { cwd: worktree, maxBuffer: MAX_BUFFER, encoding: "utf8" });
  return stdout;
}
