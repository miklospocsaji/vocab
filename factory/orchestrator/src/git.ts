/**
 * Git plumbing for work items: one worktree per change id outside the owner's checkout,
 * commits limited to the change folder, and pushes of the work item's branch.
 */
import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
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
