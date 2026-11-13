/**
 * The diff check of a role that can write (ADR 0011): every path that differs from the
 * session's starting commit, committed, staged, unstaged or untracked, is checked with the role's
 * matcher (`isWritable`, shared with the path guard). The starting commit is given by the caller,
 * never read from the clone's HEAD, so a commit made during the session hides nothing.
 * Git-ignored files never appear, so caches under `node_modules/` pass. In the build container
 * this is fast feedback; the worker's re-check of the patch is the boundary (add-build-loop).
 *
 * No role may leave a file over MAX_FILE_BYTES, wherever it is: the check names it as outside and
 * the patch leaves it out (add-build-loop, "Oversized files are never writable"). A process that
 * aborts in the build container could leave a core dump of gigabytes, and `git diff --binary`
 * crashes on a file that size.
 */
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isWritable } from "./guard.ts";

const run = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;
/** The largest file a role may leave in the worktree: 10 MB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
  const found = await changes(worktree, baseCommit);
  const oversized = await oversizedPaths(worktree, found.map((change) => change.path));
  for (const { status, path } of found) {
    const added = status === "A" || status === "?";
    if (!isWritable(path, writable) || (stubs.has(path) && !added) || oversized.has(path)) outside.add(path);
  }
  const sorted = [...outside].sort();
  return { passed: sorted.length === 0, outside: sorted };
}

/**
 * The patch from `baseCommit` to the worktree, binary-safe, built the way the check sees it:
 * untracked files are added with `--intent-to-add` first, so the patch holds them too. Files over
 * MAX_FILE_BYTES are left out; the diff check has already failed the attempt for them.
 */
export async function diffPatch(worktree: string, baseCommit: string): Promise<string> {
  await verifyCommit(worktree, baseCommit);
  const found = await changes(worktree, baseCommit);
  const oversized = await oversizedPaths(worktree, found.map((change) => change.path));
  const untracked = found.filter((change) => change.status === "?" && !oversized.has(change.path)).map((change) => change.path);
  if (untracked.length > 0) await git(worktree, ["add", "--intent-to-add", "--", ...untracked]);
  const excluded = [...oversized].sort().map((path) => `:(exclude,literal)${path}`);
  return git(worktree, ["diff", "--binary", "--no-renames", "--no-color", "--no-ext-diff", baseCommit, "--", ...(excluded.length > 0 ? [".", ...excluded] : [])]);
}

/** The paths that are regular files over MAX_FILE_BYTES in the worktree; a deleted path is not. */
async function oversizedPaths(worktree: string, paths: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const path of paths) {
    const stats = await lstat(join(worktree, path)).catch(() => undefined);
    if (stats?.isFile() === true && stats.size > MAX_FILE_BYTES) found.add(path);
  }
  return found;
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
