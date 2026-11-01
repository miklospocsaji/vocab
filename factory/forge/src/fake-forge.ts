/**
 * Test helper: an in-memory Forge for orchestrator tests. It passes the same contract tests
 * as GitHubForge. `pushBranch` really pushes to the worktree's `origin`, which in tests is
 * a temp bare repo, so no credentials are involved.
 */
import { execFile } from "node:child_process";
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
}

export interface FakeComment {
  issueNumber: number;
  body: string;
}

const FAKE_SHA = "fa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e";

const execFileAsync = promisify(execFile);

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

  constructor(options: FakeForgeOptions = {}) {
    this.#defaultBranch = options.defaultBranch ?? "master";
    this.#branches.set(this.#defaultBranch, options.defaultSha ?? FAKE_SHA);
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
    this.#branches.set(branch, sha);
  }

  /** The branch head, or undefined when the branch does not exist. */
  branchSha(branch: string): string | undefined {
    return this.#branches.get(branch);
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

  branchExists(branch: string): Promise<boolean> {
    return Promise.resolve(this.#branches.has(branch));
  }

  createBranch(branch: string): Promise<CreatedBranch> {
    const existing = this.#branches.get(branch);
    if (existing !== undefined) return Promise.resolve({ created: false, sha: existing });
    const sha = this.#branches.get(this.#defaultBranch) ?? FAKE_SHA;
    this.#branches.set(branch, sha);
    return Promise.resolve({ created: true, sha });
  }

  async pushBranch(options: PushBranchOptions): Promise<void> {
    const { worktree, branch } = options;
    try {
      await git(worktree, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
      this.#branches.set(branch, await git(worktree, "rev-parse", `refs/heads/${branch}`));
    } catch (error) {
      throw new ForgeError(`pushing branch ${branch} failed: ${error instanceof Error ? error.message : String(error)}`, "failed");
    }
  }
}

function notFound(issueNumber: number): ForgeError {
  return new ForgeError(`issue #${String(issueNumber)} not found`, "not-found", 404);
}
