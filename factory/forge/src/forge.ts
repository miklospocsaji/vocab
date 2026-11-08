/**
 * The Forge: everything the factory needs from the code host. M1 implements it on GitHub
 * with the owner's token (GitHubForge); M2 swaps in GitHub App installation tokens.
 */

export interface Issue {
  number: number;
  title: string;
  /** The issue body; an issue without one has `""`. */
  body: string;
  state: "open" | "closed";
  url: string;
}

export interface CreatedBranch {
  /** False when the branch already existed and was left as it was. */
  created: boolean;
  /** The branch head after the call. */
  sha: string;
}

export interface PushBranchOptions {
  /** The work item's worktree, with the branch checked out. */
  worktree: string;
  branch: string;
}

export interface Forge {
  /** Rejects with a `not-found` ForgeError when there is no such issue. */
  getIssue(issueNumber: number): Promise<Issue>;
  comment(issueNumber: number, body: string): Promise<void>;
  branchExists(branch: string): Promise<boolean>;
  /** Creates the branch at the default branch's head; a no-op if the branch exists. */
  createBranch(branch: string): Promise<CreatedBranch>;
  /** Pushes the worktree's branch to the forge's repository. */
  pushBranch(options: PushBranchOptions): Promise<void>;
  /**
   * Clones the forge's repository into `directory`, which must not exist yet; its parent must.
   * The clone's `origin` is the repository, and no credential is stored in the clone.
   */
  clone(directory: string): Promise<void>;
}

export type ForgeErrorKind = "not-found" | "unauthorized" | "failed";

/** A failed Forge call. Its message never contains a credential. */
export class ForgeError extends Error {
  override readonly name = "ForgeError";
  readonly kind: ForgeErrorKind;
  /** The HTTP status, when the call reached the forge. */
  readonly status: number | undefined;

  constructor(message: string, kind: ForgeErrorKind, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}
