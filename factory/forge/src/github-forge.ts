/**
 * The Forge on GitHub, through `@octokit/rest`. M1 authenticates with the owner's token
 * from `gh auth token`; M2 swaps in GitHub App installation tokens.
 *
 * The token is held in private fields only, so it never shows up in `inspect` or JSON of
 * the forge, and errors are rebuilt as ForgeErrors without the request (and its headers).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { ForgeError, type CreatedBranch, type Forge, type ForgeErrorKind, type Issue, type PushBranchOptions } from "./forge.ts";

/** Runs git; GitHubForge uses it only to push. */
export type RunGit = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<void>;

export interface GitHubForgeLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GitHubForgeOptions {
  owner: string;
  repo: string;
  /** From `gh auth token` locally (see `ghAuthToken`); never logged. */
  token: string;
  /** Defaults to the global `fetch`; tests inject one so nothing reaches the network. */
  fetch?: typeof fetch;
  /** The REST API root; defaults to `https://api.github.com`. */
  baseUrl?: string;
  /** The git host pushes go to; defaults to `https://github.com`. */
  gitBaseUrl?: string;
  /** Defaults to running `git` as a child process. */
  git?: RunGit;
  /** Receives Octokit's log lines; defaults to discarding them. */
  log?: GitHubForgeLogger;
}

/** The environment variable that carries the token to the credential helper, and only to it. */
const TOKEN_VAR = "FACTORY_GITHUB_TOKEN";

/**
 * A git credential helper that answers `get` with the token from the environment. The token
 * never appears in the remote URL, the command line or git's config files.
 */
const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${TOKEN_VAR}"; }; f`;

const silent: GitHubForgeLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const execFileAsync = promisify(execFile);

const defaultGit: RunGit = async (args, { cwd, env }) => {
  await execFileAsync("git", args, { cwd, env, encoding: "utf8" });
};

export class GitHubForge implements Forge {
  readonly #owner: string;
  readonly #repo: string;
  readonly #token: string;
  readonly #gitBaseUrl: string;
  readonly #git: RunGit;
  readonly #octokit: Octokit;

  constructor(options: GitHubForgeOptions) {
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#token = options.token;
    this.#gitBaseUrl = (options.gitBaseUrl ?? "https://github.com").replace(/\/+$/, "");
    this.#git = options.git ?? defaultGit;
    this.#octokit = new Octokit({
      auth: options.token,
      log: options.log ?? silent,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
    });
  }

  async getIssue(issueNumber: number): Promise<Issue> {
    const { data } = await this.#call(`reading issue #${String(issueNumber)}`, () =>
      this.#octokit.rest.issues.get({ owner: this.#owner, repo: this.#repo, issue_number: issueNumber }),
    );
    // The issues endpoint also serves pull requests; a work item comes from an issue only.
    if (data.pull_request !== undefined) {
      throw new ForgeError(`#${String(issueNumber)} is a pull request, not an issue`, "not-found", 404);
    }
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      state: data.state === "closed" ? "closed" : "open",
      url: data.html_url,
    };
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    await this.#call(`commenting on issue #${String(issueNumber)}`, () =>
      this.#octokit.rest.issues.createComment({ owner: this.#owner, repo: this.#repo, issue_number: issueNumber, body }),
    );
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.#branchSha(branch)) !== undefined;
  }

  async createBranch(branch: string): Promise<CreatedBranch> {
    const existing = await this.#branchSha(branch);
    if (existing !== undefined) return { created: false, sha: existing };

    const { data: repository } = await this.#call("reading the repository", () =>
      this.#octokit.rest.repos.get({ owner: this.#owner, repo: this.#repo }),
    );
    const sha = await this.#branchSha(repository.default_branch);
    if (sha === undefined) throw new ForgeError(`the default branch ${repository.default_branch} does not exist`, "not-found", 404);

    try {
      await this.#call(`creating branch ${branch}`, () =>
        this.#octokit.rest.git.createRef({ owner: this.#owner, repo: this.#repo, ref: `refs/heads/${branch}`, sha }),
      );
      return { created: true, sha };
    } catch (error) {
      // Created by someone else since the check: GitHub answers 422 "Reference already exists".
      if (error instanceof ForgeError && error.status === 422) {
        const raced = await this.#branchSha(branch);
        if (raced !== undefined) return { created: false, sha: raced };
      }
      throw error;
    }
  }

  async pushBranch(options: PushBranchOptions): Promise<void> {
    const { worktree, branch } = options;
    const url = `${this.#gitBaseUrl}/${this.#owner}/${this.#repo}.git`;
    const args = [
      // An empty helper clears every inherited one (gh's, the OS keychain's), so only ours answers.
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${CREDENTIAL_HELPER}`,
      "push",
      url,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, [TOKEN_VAR]: this.#token, GIT_TERMINAL_PROMPT: "0" };
    try {
      await this.#git(args, { cwd: worktree, env });
    } catch (error) {
      throw new ForgeError(`pushing branch ${branch} failed: ${this.#scrub(messageOf(error))}`, "failed");
    }
  }

  async #branchSha(branch: string): Promise<string | undefined> {
    try {
      const { data } = await this.#call(`reading branch ${branch}`, () =>
        this.#octokit.rest.git.getRef({ owner: this.#owner, repo: this.#repo, ref: `heads/${branch}` }),
      );
      return data.object.sha;
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "not-found") return undefined;
      throw error;
    }
  }

  /** Runs an Octokit call, turning any failure into a ForgeError without the request attached. */
  async #call<T>(what: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      const status = statusOf(error);
      const kind: ForgeErrorKind = status === 404 ? "not-found" : status === 401 ? "unauthorized" : "failed";
      throw new ForgeError(`GitHub: ${what} failed: ${this.#scrub(messageOf(error))}`, kind, status);
    }
  }

  #scrub(text: string): string {
    return this.#token === "" ? text : text.replaceAll(this.#token, "[REDACTED]");
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
