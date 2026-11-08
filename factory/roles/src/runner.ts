/**
 * Runs one attempt of a role as an Agent SDK session: the role's tools, `dontAsk`
 * permissions, project-only settings, the path and read guards, the Bash sandbox (ADR 0007)
 * and a child env built from an allowlist, with only the effective auth mode's credential
 * (ADR 0006). Every message goes to the Recorder. Anything but a valid result and a valid
 * change is an AttemptFailed.
 */
import { execFile } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { query as sdkQuery, type Options, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writableFor, type Role, type RoleConfig } from "./config.ts";
import { createPathGuard, createReadGuard } from "./guard.ts";
import { renderPrompt, type PromptArtifact, type PromptIssue, type RetryEvidence } from "./prompt.ts";

const run = promisify(execFile);

/** The factory's own bin: roles run its pinned openspec, never one from the worktree. */
const FACTORY_BIN = resolve(import.meta.dirname, "../../../node_modules/.bin");
/** All a session inherits from the worker's environment; PATH is handled apart, and LC_* also passes. */
const INHERITED = new Set(["HOME", "TMPDIR", "LANG", "TZ", "NODE_EXTRA_CA_CERTS"]);
/** Per auth mode: the one credential passed to the child, and the `apiKeySource` the init message must report. */
const AUTH = {
  "api-key": { credential: "ANTHROPIC_API_KEY", apiKeySource: "ANTHROPIC_API_KEY" },
  subscription: { credential: "CLAUDE_CODE_OAUTH_TOKEN", apiKeySource: "none" },
} as const;
const RESULT_FAILURES: Record<Exclude<SDKResultMessage["subtype"], "success">, FailureReason> = {
  error_max_turns: "max-turns",
  error_max_budget_usd: "budget",
  error_during_execution: "error",
  error_max_structured_output_retries: "invalid-result",
};

export type FailureReason =
  | "max-turns"
  | "budget"
  | "error"
  | "no-result"
  | "invalid-result"
  | "invalid-change"
  | "auth-mode-mismatch"
  | "config";

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
  const { recorder, query = sdkQuery, env = process.env } = options;

  return async (role, item, evidence) => {
    const authMode = effectiveAuthMode(role, env);
    const auth = AUTH[authMode];
    const baseEnv = childEnv(env);
    const credential = env[auth.credential];
    const abortController = new AbortController();
    const session = query({
      prompt: renderPrompt(evidence === undefined ? item : { ...item, evidence }),
      options: {
        cwd: item.worktree,
        model: role.model,
        systemPrompt: role.prompt,
        tools: role.tools.filter((tool) => !isAgentTool(tool)),
        allowedTools: role.allow.filter((rule) => !isAgentTool(rule)),
        permissionMode: "dontAsk",
        settingSources: ["project"],
        skills: role.skills,
        maxTurns: role.maxTurns,
        maxBudgetUsd: role.maxBudgetUsd,
        // The CLI validates --json-schema as draft-07 and rejects zod's default 2020-12 `$schema`.
        outputFormat: { type: "json_schema", schema: z.toJSONSchema(role.schema, { target: "draft-07" }) },
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write|NotebookEdit",
              hooks: [createPathGuard({ role: role.name, worktree: item.worktree, writable: writableFor(role, item.changeId) })],
            },
            {
              matcher: "Read|Grep|Glob",
              hooks: [createReadGuard({ role: role.name, worktree: item.worktree })],
            },
          ],
        },
        // ADR 0007: Bash cannot write anywhere in the worktree; files change only through the guarded tools.
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          // The SDK default (true) auto-approves every sandboxed command and bypasses the role's Bash allowlist.
          autoAllowBashIfSandboxed: false,
          allowUnsandboxedCommands: false,
          filesystem: { denyWrite: [item.worktree] },
        },
        env: credential === undefined ? baseEnv : { ...baseEnv, [auth.credential]: credential },
        abortController,
      },
    });

    let result: SDKResultMessage | undefined;
    try {
      for await (const message of session) {
        await recorder.record(item.id, role.name, message);
        if (message.type === "system" && message.subtype === "init" && message.apiKeySource !== auth.apiKeySource) {
          // Before any tool runs: stop the session and take nothing more from it.
          abortController.abort();
          throw new AttemptFailed(
            "auth-mode-mismatch",
            `role ${role.name} runs in ${authMode} mode (apiKeySource ${auth.apiKeySource}), but the session reported apiKeySource ${message.apiKeySource}`,
          );
        }
        if (message.type === "result") result = message;
      }
    } catch (error) {
      if (error instanceof AttemptFailed) throw error;
      // The SDK throws after an error result; the result itself classifies the attempt.
      if (result === undefined) throw new AttemptFailed("error", error instanceof Error ? error.message : String(error));
    }

    if (result === undefined) throw new AttemptFailed("no-result", "the session ended without a result message");
    if (result.subtype !== "success") throw new AttemptFailed(RESULT_FAILURES[result.subtype], [result.subtype, ...result.errors].join("\n"));
    if (result.is_error) throw new AttemptFailed("error", result.result);
    if (result.structured_output === undefined) throw new AttemptFailed("invalid-result", "the result has no structured output");

    const parsed = role.schema.safeParse(result.structured_output);
    if (!parsed.success) throw new AttemptFailed("invalid-result", z.prettifyError(parsed.error));

    await validateChange(item, baseEnv);
    return parsed.data;
  };
}

/** FACTORY_AUTH_MODE if set, otherwise the role's config. The value is not echoed, in case a secret was set there by mistake. */
function effectiveAuthMode(role: Role, env: Record<string, string | undefined>): RoleConfig["authMode"] {
  const override = env["FACTORY_AUTH_MODE"];
  if (override === undefined) return role.authMode;
  if (override === "api-key" || override === "subscription") return override;
  throw new AttemptFailed("config", "FACTORY_AUTH_MODE must be api-key or subscription");
}

/** Only the allowlisted variables of the parent env, with OpenSpec quiet and the factory's bin first on PATH. The caller adds the credential. */
function childEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && (INHERITED.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  env["OPENSPEC_TELEMETRY"] = "0";
  env["PATH"] = [FACTORY_BIN, ...(parent["PATH"] ? [parent["PATH"]] : [])].join(delimiter);
  return env;
}

/** Roles never get the Agent tool, so they cannot start subagents. */
function isAgentTool(rule: string): boolean {
  return rule === "Agent" || rule.startsWith("Agent(");
}

/**
 * `openspec validate <id> --strict` on the worktree, run by the runner itself with its own node
 * on PATH for the bin shim. A failure carries openspec's JSON report as evidence.
 */
async function validateChange(item: WorkItem, baseEnv: Record<string, string>): Promise<void> {
  const env = { ...baseEnv, PATH: [dirname(process.execPath), baseEnv["PATH"]].join(delimiter) };
  try {
    await run(join(FACTORY_BIN, "openspec"), ["validate", item.changeId, "--strict", "--json", "--no-interactive"], { cwd: item.worktree, env });
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim() !== "") throw new AttemptFailed("invalid-change", stdout.trim());
    throw new AttemptFailed("error", `openspec validate ${item.changeId} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
