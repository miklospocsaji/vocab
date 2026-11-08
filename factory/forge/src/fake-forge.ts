/**
 * Test helper: an in-memory Forge for orchestrator tests. It passes the same contract tests
 * as GitHubForge. `pushBranch` really pushes to the worktree's `origin`, which in tests is
 * a temp bare repo, so no credentials are involved.
 *
 * With the `remote` option, branches live in that git repository instead of in memory, so
 * a branch Intake creates can be fetched by a worktree, as on the real forge. Issues and
 * comments stay in memory either way.
 */
import { execFile, execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { ForgeError, type CreatedBranch, type Forge, type Issue, type PushBranchOptions } from "./forge.ts";

export interface FakeIssue {
  number: number;
  title: string;
  /** `null` is an issue without a body, as GitHub returns it. */
  body?: string | null;
  state?: "open" | "closed";
}

export interface FakeForgeOptions {
  /** Defaults to `master`. */
  defaultBranch?: string;
  /** The default branch's head; defaults to a fixed fake sha. */
  defaultSha?: string;
  issues?: FakeIssue[];
  /**
   * A git repository (a temp bare repo in tests) that plays the forge's repository. When
   * set, branches live in it, and `defaultSha` is ignored.
   */
  remote?: string;
}

export interface FakeComment {
  issueNumber: number;
  body: string;
}

const FAKE_SHA = "fa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e";

const execFileAsync = promisify(execFile);

/** Git's "no old value": `update-ref <ref> <new> <ZERO>` creates the ref only if it does not exist. */
const ZERO_SHA = "0000000000000000000000000000000000000000";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

export class FakeForge implements Forge {
  /** Every comment posted, in order. */
  readonly comments: FakeComment[] = [];

  readonly #defaultBranch: string;
  readonly #issues = new Map<number, Issue>();
  readonly #branches = new Map<string, string>();
  readonly #remote: string | undefined;

  constructor(options: FakeForgeOptions = {}) {
    this.#defaultBranch = options.defaultBranch ?? "master";
    this.#remote = options.remote;
    if (this.#remote === undefined) this.#branches.set(this.#defaultBranch, options.defaultSha ?? FAKE_SHA);
    for (const issue of options.issues ?? []) this.addIssue(issue);
  }

  addIssue(issue: FakeIssue): void {
    this.#issues.set(issue.number, {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state ?? "open",
      url: `https://forge.invalid/issues/${String(issue.number)}`,
    });
  }

  /** Sets a branch head directly, as if someone else had pushed it. */
  setBranch(branch: string, sha: string): void {
    if (this.#remote === undefined) this.#branches.set(branch, sha);
    else execFileSync("git", ["update-ref", `refs/heads/${branch}`, sha], { cwd: this.#remote, stdio: "ignore" });
  }

  /** The branch head, or undefined when the branch does not exist. */
  branchSha(branch: string): string | undefined {
    if (this.#remote === undefined) return this.#branches.get(branch);
    try {
      return execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.#remote, encoding: "utf8" }).trim();
    } catch {
      return undefined;
    }
  }

  getIssue(issueNumber: number): Promise<Issue> {
    const issue = this.#issues.get(issueNumber);
    return issue === undefined ? Promise.reject(notFound(issueNumber)) : Promise.resolve({ ...issue });
  }

  comment(issueNumber: number, body: string): Promise<void> {
    if (!this.#issues.has(issueNumber)) return Promise.reject(notFound(issueNumber));
    this.comments.push({ issueNumber, body });
    return Promise.resolve();
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.#headOf(branch)) !== undefined;
  }

  async createBranch(branch: string): Promise<CreatedBranch> {
    const existing = await this.#headOf(branch);
    if (existing !== undefined) return { created: false, sha: existing };
    if (this.#remote === undefined) {
      const sha = this.#branches.get(this.#defaultBranch) ?? FAKE_SHA;
      this.#branches.set(branch, sha);
      return { created: true, sha };
    }
    const sha = await this.#headOf(this.#defaultBranch);
    if (sha === undefined) throw new ForgeError(`default branch ${this.#defaultBranch} not found in ${this.#remote}`, "failed");
    try {
      await git(this.#remote, "update-ref", `refs/heads/${branch}`, sha, ZERO_SHA);
    } catch {
      // Created in the meantime: leave it where it is, as GitHub does.
      const now = await this.#headOf(branch);
      if (now !== undefined) return { created: false, sha: now };
      throw new ForgeError(`creating branch ${branch} failed`, "failed");
    }
    return { created: true, sha };
  }

  async pushBranch(options: PushBranchOptions): Promise<void> {
    const { worktree, branch } = options;
    try {
      await git(worktree, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
      // With a remote, the push itself moved the branch there.
      if (this.#remote === undefined) this.#branches.set(branch, await git(worktree, "rev-parse", `refs/heads/${branch}`));
    } catch (error) {
      throw new ForgeError(`pushing branch ${branch} failed: ${error instanceof Error ? error.message : String(error)}`, "failed");
    }
  }

  /** Clones the `remote`; without one there is no repository to clone. */
  async clone(directory: string): Promise<void> {
    if (this.#remote === undefined) throw new ForgeError("FakeForge has no remote to clone", "failed");
    try {
      await git(dirname(directory), "clone", "--quiet", this.#remote, directory);
    } catch (error) {
      throw new ForgeError(`cloning into ${directory} failed: ${error instanceof Error ? error.message : String(error)}`, "failed");
    }
  }

  async #headOf(branch: string): Promise<string | undefined> {
    if (this.#remote === undefined) return this.#branches.get(branch);
    return git(this.#remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => undefined);
  }
}

function notFound(issueNumber: number): ForgeError {
  return new ForgeError(`issue #${String(issueNumber)} not found`, "not-found", 404);
}
