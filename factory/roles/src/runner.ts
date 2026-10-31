/**
 * Runs one attempt of a role as an Agent SDK session: the role's tools, `dontAsk`
 * permissions, project-only settings, the path guard, the Bash sandbox (ADR 0007) and an
 * explicit child env with only the configured mode's credential (ADR 0006). Every message
 * goes to the Recorder. Anything but a valid result and a valid change is an AttemptFailed.
 */
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "./config.ts";
import type { PromptArtifact, PromptIssue, RetryEvidence } from "./prompt.ts";

export type FailureReason =
  | "max-turns"
  | "budget"
  | "error"
  | "no-result"
  | "invalid-result"
  | "invalid-change"
  | "auth-mode-mismatch";

export class AttemptFailed extends Error {
  readonly reason: FailureReason;
  readonly evidence: string;

  constructor(reason: FailureReason, evidence: string) {
    super(`attempt failed: ${reason}`);
    this.name = "AttemptFailed";
    this.reason = reason;
    this.evidence = evidence;
  }
}

/** Where every SDK message of an attempt goes; the ledger implements it in add-local-proposal-run. */
export interface Recorder {
  record(itemId: string, role: string, message: SDKMessage): Promise<void>;
}

export interface WorkItem {
  id: string;
  changeId: string;
  /** The work item's worktree: the session's `cwd`. */
  worktree: string;
  issue: PromptIssue;
  changeFiles: PromptArtifact[];
  specs: PromptArtifact[];
}

/** The shape of the SDK's `query`, so tests can inject a stub. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface RunnerOptions {
  recorder: Recorder;
  /** Defaults to the SDK's `query`. */
  query?: QueryFn;
  /** The parent env the child env is built from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Resolves to the role's parsed result; rejects with AttemptFailed. */
export type RunRole = (role: Role, item: WorkItem, evidence?: RetryEvidence) => Promise<unknown>;

export function createRunner(options: RunnerOptions): RunRole {
  const source = options.query === undefined ? "the SDK" : "an injected";
  return (role) => Promise.reject(new Error(`runRole is not implemented yet (add-role-runner task 5.2): role ${role.name}, ${source} query`));
}
