/**
 * Git plumbing for work items: one worktree per change id outside the owner's checkout,
 * commits limited to the change folder, and pushes of the work item's branch.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * The author and committer of factory commits. `.invalid` can never be a real domain, so
 * GitHub never links these commits to someone's account. M2 swaps in the GitHub App's bot.
 */
export const FACTORY_GIT_IDENTITY: GitIdentity = { name: "Vocab Factory", email: "factory@vocab.invalid" };

export interface EnsureWorktreeOptions {
  /** The local clone the worktree is added to; its `origin` is the remote. */
  repo: string;
  changeId: string;
  /** The work item's branch, which already exists on the remote. */
  branch: string;
  /** The factory's home directory; defaults to `factoryHome()`. */
  home?: string;
}

export interface CommitChangeOptions {
  worktree: string;
  changeId: string;
  message: string;
  /** Defaults to `FACTORY_GIT_IDENTITY`. */
  identity?: GitIdentity;
}

export interface PushOptions {
  worktree: string;
  branch: string;
}

/** `$FACTORY_HOME`, or `~/.factory` when it is unset or empty. */
export function factoryHome(env: Record<string, string | undefined> = process.env): string {
  const home = env["FACTORY_HOME"];
  return home === undefined || home.trim() === "" ? join(homedir(), ".factory") : home;
}

/** `<home>/worktrees/<change-id>`. */
export function worktreePath(changeId: string, home: string = factoryHome()): string {
  return join(home, "worktrees", changeId);
}

/**
 * Creates the work item's worktree on its branch, at the remote's head, or returns the
 * existing one unchanged, uncommitted work included.
 */
export async function ensureWorktree(options: EnsureWorktreeOptions): Promise<string> {
  const { repo, changeId, branch, home = factoryHome() } = options;
  const path = worktreePath(changeId, home);
  if (await isWorktreeRoot(path)) return path;

  await git(repo, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  // Forget worktrees whose directories were deleted, so the path and branch can be reused.
  await git(repo, "worktree", "prune");
  await mkdir(dirname(path), { recursive: true });
  await git(repo, "worktree", "add", "-B", branch, path, `origin/${branch}`);
  return path;
}

async function isWorktreeRoot(path: string): Promise<boolean> {
  const isDirectory = await stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDirectory) return false;
  const top = await git(path, "rev-parse", "--show-toplevel").catch(() => undefined);
  return top !== undefined && top === (await realpath(path));
}

/** Commits the change folder, and nothing else, on the worktree's branch; returns the commit sha. */
export async function commitChange(options: CommitChangeOptions): Promise<string> {
  const { worktree, changeId, message, identity = FACTORY_GIT_IDENTITY } = options;
  const folder = `openspec/changes/${changeId}`;
  await git(worktree, "add", "--all", "--", folder);
  // With a pathspec, `commit` takes only those paths, whatever else is staged.
  await git(worktree, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--message", message, "--", folder);
  return git(worktree, "rev-parse", "HEAD");
}

/** Pushes the branch to `origin`. */
export async function push(options: PushOptions): Promise<void> {
  const { worktree, branch } = options;
  await git(worktree, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
}


export interface CommitPathsOptions {
  worktree: string;
  /** Worktree-relative files or folders; those without changes, or that do not exist, are left out. */
  paths: readonly string[];
  message: string;
  /** Defaults to `FACTORY_GIT_IDENTITY`. */
  identity?: GitIdentity;
}

/**
 * Commits the changes under `paths`, and nothing else, on the worktree's branch. Returns the new
 * commit's sha, or undefined when nothing under `paths` changed.
 */
export async function commitPaths(options: CommitPathsOptions): Promise<string | undefined> {
  const { worktree, paths, message, identity = FACTORY_GIT_IDENTITY } = options;
  const changed = await changedUnder(worktree, paths);
  if (changed.length === 0) return undefined;
  await git(worktree, "add", "--all", "--", ...changed);
  await git(worktree, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--message", message, "--", ...changed);
  return git(worktree, "rev-parse", "HEAD");
}

/** The files under `paths` that differ from HEAD, untracked ones included. */
async function changedUnder(worktree: string, paths: readonly string[]): Promise<string[]> {
  const { stdout } = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths], { cwd: worktree, encoding: "utf8" });
  // Entries are `XY path`, NUL-separated; a rename adds its source as the next entry.
  const entries = stdout.split("\0").filter((entry) => entry !== "");
  const files: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? "";
    files.push(entry.slice(3));
    if (entry.startsWith("R") || entry.startsWith("C")) i += 1;
  }
  return files;
}

export interface ChangeFileReaderOptions {
  /** The local clone the work item's worktree is added to. */
  repo: string;
  /** The factory's home directory; defaults to `factoryHome()`. */
  home?: string;
}

/**
 * Reads files of a work item's change folder, by their path inside it, from the work item's
 * worktree (created at the branch's head if it does not exist). A missing file is undefined.
 */
export function changeFileReader(options: ChangeFileReaderOptions): (workItem: { changeId: string; branch: string }, path: string) => Promise<string | undefined> {
  return async (workItem, path) => {
    const worktree = await ensureWorktree({ repo: options.repo, changeId: workItem.changeId, branch: workItem.branch, ...(options.home === undefined ? {} : { home: options.home }) });
    try {
      return await readFile(join(worktree, "openspec/changes", workItem.changeId, path), "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw error;
    }
  };
}
