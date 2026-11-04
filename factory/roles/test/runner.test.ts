import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type {
  ApiKeySource,
  HookJSONOutput,
  ModelUsage,
  NonNullableUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSessionStateChangedMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ProposalResult } from "@vocab/factory-artifacts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Role } from "../src/config.ts";
import { renderPrompt, type RetryEvidence } from "../src/prompt.ts";
import { AttemptFailed, createRunner, type QueryFn, type Recorder, type WorkItem } from "../src/runner.ts";

const CHANGE_ID = "add-sample";
const CHANGE = `openspec/changes/${CHANGE_ID}`;
const MODEL = "claude-haiku-5-5";
const SESSION = "session-1";
// The factory's own bin: roles run its pinned openspec, never one from the worktree.
const FACTORY_BIN = resolve(import.meta.dirname, "../../../node_modules/.bin");

const VALID_RESULT: ProposalResult = {
  changeId: CHANGE_ID,
  capabilities: ["roles"],
  complexity: "small",
  summary: "A sample change.",
  openQuestions: [],
};

// A parent Claude Code session with every kind of credential and override in its env.
const PARENT_ENV = {
  HOME: "/home/factory",
  LANG: "C.UTF-8",
  PATH: ["/usr/local/bin", "/usr/bin"].join(delimiter),
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_API_KEY: "api-key",
  ANTHROPIC_AUTH_TOKEN: "bearer-token",
  ANTHROPIC_BASE_URL: "https://proxy.example",
};

// What a worker task holds for itself, none of it for a role session.
const WORKER_SECRETS = {
  FACTORY_GITHUB_TOKEN: "github-token-value",
  AWS_ACCESS_KEY_ID: "aws-access-key-id-value",
  AWS_SECRET_ACCESS_KEY: "aws-secret-access-key-value",
  AWS_SESSION_TOKEN: "aws-session-token-value",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/value",
  ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/value",
  FACTORY_DATABASE_URL: "postgres://factory:database-password-value@ledger/factory",
};

let worktree: string;

function sampleRole(overrides: Partial<Role> = {}): Role {
  return {
    name: "sample-role",
    model: MODEL,
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    allow: ["Read", "Grep", "Glob", "Bash(openspec validate:*)"],
    writable: ["openspec/changes/{changeId}/proposal.md", "openspec/changes/{changeId}/specs/**/spec.md"],
    skills: ["sample-skill"],
    maxTurns: 5,
    maxBudgetUsd: 0.1,
    resultSchema: "proposal-result",
    authMode: "subscription",
    prompt: "You are a sample role.",
    schema: ProposalResult,
    ...overrides,
  };
}

function workItem(): WorkItem {
  return {
    id: "item-1",
    changeId: CHANGE_ID,
    worktree,
    issue: { title: "Add a sample", body: "Please add a sample." },
    changeFiles: [{ path: `${CHANGE}/proposal.md`, content: "# Proposal\n" }],
    specs: [],
  };
}

// Messages shaped like SDK 0.3.310's (sdk.d.ts), as the task 1.3 spike observed them.

const usage: NonNullableUsage = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: null,
  inference_geo: "",
  input_tokens: 100,
  iterations: [],
  output_tokens: 20,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
};

function modelUsage(costUSD: number): Record<string, ModelUsage> {
  return {
    [MODEL]: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    },
  };
}

function init(apiKeySource: ApiKeySource = "none"): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource,
    claude_code_version: "2.3.310",
    cwd: worktree,
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    mcp_servers: [],
    model: MODEL,
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: ["sample-skill"],
    plugins: [],
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

function toolUse(): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_1",
      container: null,
      content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: `${CHANGE}/proposal.md`, content: "# Proposal\n" } }],
      context_management: null,
      diagnostics: null,
      model: MODEL,
      role: "assistant",
      stop_details: null,
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      usage,
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

function success(structuredOutput: unknown, isError = false): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: isError,
    num_turns: 2,
    result: isError ? "API Error: 500 Internal Server Error" : "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage,
    modelUsage: modelUsage(0.01),
    permission_denials: [],
    structured_output: structuredOutput,
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

function failure(subtype: SDKResultError["subtype"], errors: string[] = [], totalCostUsd = 0.01): SDKResultError {
  return {
    type: "result",
    subtype,
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: true,
    num_turns: 5,
    stop_reason: null,
    total_cost_usd: totalCostUsd,
    usage,
    modelUsage: modelUsage(totalCostUsd),
    permission_denials: [],
    errors,
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

// The spike: after an error result the SDK's iterator throws this.
function sdkThrow(subtype: string): Error {
  return new Error(`Claude Code returned an error result: ${subtype}`);
}

// Informational system messages may follow the result.
function idle(): SDKSessionStateChangedMessage {
  return { type: "system", subtype: "session_state_changed", state: "idle", uuid: randomUUID(), session_id: SESSION };
}

interface Recorded {
  itemId: string;
  role: string;
  message: SDKMessage;
}

class MemoryRecorder implements Recorder {
  readonly entries: Recorded[] = [];

  record(itemId: string, role: string, message: SDKMessage): Promise<void> {
    this.entries.push({ itemId, role, message });
    return Promise.resolve();
  }
}

type Outcome = { value: unknown } | { error: unknown };

interface Run {
  outcome: Outcome;
  calls: { prompt: string; options: Options }[];
  recorder: MemoryRecorder;
  /** How many messages the runner took from the stubbed session. */
  pulled: number;
}

interface RunInput {
  role?: Role;
  evidence?: RetryEvidence;
  env?: Record<string, string | undefined>;
}

/** Runs the role against a stubbed `query` that yields `steps` in order, throwing at an Error. */
async function run(steps: (SDKMessage | Error)[], input: RunInput = {}): Promise<Run> {
  const calls: Run["calls"] = [];
  let pulled = 0;
  const query: QueryFn = (params) => {
    calls.push(params);
    return (async function* () {
      for (const step of steps) {
        await Promise.resolve();
        if (step instanceof Error) throw step;
        pulled += 1;
        yield step;
      }
    })();
  };
  const recorder = new MemoryRecorder();
  const runRole = createRunner({ query, recorder, env: input.env ?? PARENT_ENV });
  let outcome: Outcome;
  try {
    outcome = { value: await runRole(input.role ?? sampleRole(), workItem(), input.evidence) };
  } catch (error) {
    outcome = { error };
  }
  return { outcome, calls, recorder, pulled };
}

function onlyOptions(result: Run): Options {
  expect(result.calls).toHaveLength(1);
  const call = result.calls[0];
  if (call === undefined) throw new Error("query was not called");
  return call.options;
}

function failed(outcome: Outcome): AttemptFailed {
  expect(outcome).toHaveProperty("error");
  const error = "error" in outcome ? outcome.error : undefined;
  expect(error).toBeInstanceOf(AttemptFailed);
  return error as AttemptFailed;
}

function keysWithPrefix(env: Options["env"], prefix: string): string[] {
  return Object.keys(env ?? {}).filter((key) => key.startsWith(prefix));
}

function hookDecision(output: HookJSONOutput): { decision?: string | undefined; reason?: string | undefined } {
  const specific = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
  return specific?.hookEventName === "PreToolUse"
    ? { decision: specific.permissionDecision, reason: specific.permissionDecisionReason }
    : {};
}

function writeDeltaSpec(): void {
  mkdirSync(join(worktree, CHANGE, "specs/roles"), { recursive: true });
  writeFileSync(
    join(worktree, CHANGE, "specs/roles/spec.md"),
    "## ADDED Requirements\n\n### Requirement: Sample behaviour\nThe system SHALL do the sample thing.\n\n#### Scenario: Sample works\n- **WHEN** the sample runs\n- **THEN** it works\n",
  );
}

beforeEach(() => {
  // realpath: the temp dir may itself sit behind a symlink.
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "vocab-runner-")));
  mkdirSync(join(worktree, CHANGE), { recursive: true });
  writeFileSync(
    join(worktree, CHANGE, "proposal.md"),
    "# Proposal\n\n## Why\n\nA sample change for the runner tests, long enough for strict validation.\n\n## What Changes\n\n- A sample requirement.\n",
  );
  writeDeltaSpec();
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe("runRole", () => {
  // Control: without it, a runner that always fails would pass every failure test below.
  it("resolves to the parsed result of a successful session with a valid change", async () => {
    const { outcome } = await run([init(), toolUse(), success(VALID_RESULT)]);
    expect(outcome).toEqual({ value: VALID_RESULT });
  });

  describe("SDK options", () => {
    it("passes the role's tools, permissions, settings, skills, limits and output format", async () => {
      const options = onlyOptions(await run([init(), success(VALID_RESULT)]));
      const role = sampleRole();
      expect(options).toMatchObject({
        cwd: worktree,
        model: MODEL,
        systemPrompt: role.prompt,
        tools: role.tools,
        allowedTools: role.allow,
        permissionMode: "dontAsk",
        settingSources: ["project"],
        skills: role.skills,
        maxTurns: role.maxTurns,
        maxBudgetUsd: role.maxBudgetUsd,
        outputFormat: { type: "json_schema" },
      });
    });

    // The CLI validates --json-schema against draft-07 and exits on zod's default 2020-12
    // `$schema` (found by the first live run). Literal expectations, not z.toJSONSchema, so
    // the test cannot share the runner's mistake.
    it("passes the result schema as draft-07 JSON Schema, keeping every constraint", async () => {
      const options = onlyOptions(await run([init(), success(VALID_RESULT)]));
      expect(options.outputFormat?.type).toBe("json_schema");
      const schema = options.outputFormat?.schema;
      expect(schema).toMatchObject({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["changeId", "capabilities", "complexity", "summary", "openQuestions"],
        properties: {
          changeId: { type: "string", pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)+$" },
          capabilities: { type: "array", minItems: 1, items: {
              type: "string",
              enum: ["vocab-import", "trajectories", "enrichment", "practice", "auth", "orchestration", "roles", "gates"],
            },
          },
          complexity: { type: "string", enum: ["small", "medium", "large"] },
          summary: { type: "string", minLength: 1 },
          openQuestions: { type: "array", items: { type: "string" } },
        },
      });
    });

    it("renders the prompt from the work item's artifacts, with the evidence on a retry", async () => {
      const item = workItem();
      const firstRun = await run([init(), success(VALID_RESULT)]);
      expect(firstRun.calls[0]?.prompt).toBe(renderPrompt(item));

      const evidence: RetryEvidence = { reason: "invalid-change", evidence: '{"valid":false}' };
      const retry = await run([init(), success(VALID_RESULT)], { evidence });
      expect(retry.calls[0]?.prompt).toBe(renderPrompt({ ...item, evidence }));
    });

    it("never gives the role the Agent tool, even when its config lists it", async () => {
      const role = sampleRole({ tools: ["Read", "Agent", "Write"], allow: ["Read", "Agent"] });
      const options = onlyOptions(await run([init(), success(VALID_RESULT)], { role }));
      expect(options.tools).toEqual(["Read", "Write"]);
      expect(options.allowedTools).toEqual(["Read"]);
    });

    it("sets the ADR 0007 sandbox: enabled, required, no unsandboxed commands and the whole worktree read-only", async () => {
      const options = onlyOptions(await run([init(), success(VALID_RESULT)]));
      expect(options.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [worktree] },
      });
      expect(options.sandbox?.filesystem?.allowWrite).toBeUndefined();
    });

    it("turns off the sandbox's Bash auto-approval, so the role's Bash allowlist decides (ADR 0007)", async () => {
      const options = onlyOptions(await run([init(), success(VALID_RESULT)]));
      // The SDK defaults this to true, which approves every sandboxed command and skips `allowedTools`.
      expect(options.sandbox?.autoAllowBashIfSandboxed).toBe(false);
    });

    it("hooks the path guard, with the work item's change id filled in, onto Edit, Write and NotebookEdit", async () => {
      const options = onlyOptions(await run([init(), success(VALID_RESULT)]));
      const matcher = (options.hooks?.PreToolUse ?? []).find((entry) => entry.matcher === "Edit|Write|NotebookEdit");
      expect(matcher?.hooks).toHaveLength(1);
      const hook = matcher?.hooks[0];
      if (hook === undefined) throw new Error("no PreToolUse hook");

      const attempt = (filePath: string) =>
        hook(
          {
            hook_event_name: "PreToolUse",
            session_id: SESSION,
            transcript_path: join(worktree, "transcript.jsonl"),
            cwd: worktree,
            tool_name: "Write",
            tool_input: { file_path: filePath, content: "x" },
            tool_use_id: "toolu_1",
          },
          "toolu_1",
          { signal: new AbortController().signal },
        );
      expect(hookDecision(await attempt(`${CHANGE}/proposal.md`)).decision).toBeUndefined();
      const denied = hookDecision(await attempt(`${CHANGE}/design.md`));
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toContain(`${CHANGE}/proposal.md`);
    });

    it("hooks the read guard, on the work item's worktree, onto Read, Grep and Glob", async () => {
      const options = onlyOptions(await run([init(), success(VALID_RESULT)]));
      const matcher = (options.hooks?.PreToolUse ?? []).find((entry) => entry.matcher === "Read|Grep|Glob");
      expect(matcher?.hooks).toHaveLength(1);
      const hook = matcher?.hooks[0];
      if (hook === undefined) throw new Error("no read guard hook");

      const attempt = (filePath: string) =>
        hook(
          {
            hook_event_name: "PreToolUse",
            session_id: SESSION,
            transcript_path: join(worktree, "transcript.jsonl"),
            cwd: worktree,
            tool_name: "Read",
            tool_input: { file_path: filePath },
            tool_use_id: "toolu_1",
          },
          "toolu_1",
          { signal: new AbortController().signal },
        );
      expect(hookDecision(await attempt(`${CHANGE}/proposal.md`)).decision).toBeUndefined();
      expect(hookDecision(await attempt("/proc/self/environ")).decision).toBe("deny");
    });
  });

  describe("child env", () => {
    it("passes only the subscription token in subscription mode, scrubbing inherited ANTHROPIC_* and CLAUDE_CODE_*", async () => {
      const { env } = onlyOptions(await run([init("none"), success(VALID_RESULT)]));
      expect(keysWithPrefix(env, "ANTHROPIC_")).toEqual([]);
      expect(keysWithPrefix(env, "CLAUDE_CODE_")).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
      expect(env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(PARENT_ENV.CLAUDE_CODE_OAUTH_TOKEN);
    });

    it("passes only the API key in api-key mode, scrubbing inherited ANTHROPIC_* and CLAUDE_CODE_*", async () => {
      const role = sampleRole({ authMode: "api-key" });
      const { env } = onlyOptions(await run([init("ANTHROPIC_API_KEY"), success(VALID_RESULT)], { role }));
      expect(keysWithPrefix(env, "CLAUDE_CODE_")).toEqual([]);
      expect(keysWithPrefix(env, "ANTHROPIC_")).toEqual(["ANTHROPIC_API_KEY"]);
      expect(env?.["ANTHROPIC_API_KEY"]).toBe(PARENT_ENV.ANTHROPIC_API_KEY);
    });

    it("turns off OpenSpec telemetry, puts the factory's node_modules/.bin first on PATH and keeps the rest", async () => {
      expect(existsSync(join(FACTORY_BIN, "openspec"))).toBe(true);
      const { env } = onlyOptions(await run([init(), success(VALID_RESULT)]));
      expect(env?.["OPENSPEC_TELEMETRY"]).toBe("0");
      expect(env?.["PATH"]?.split(delimiter)).toEqual([FACTORY_BIN, "/usr/local/bin", "/usr/bin"]);
      expect(env?.["HOME"]).toBe(PARENT_ENV.HOME);
      expect(env?.["LANG"]).toBe(PARENT_ENV.LANG);
    });

    it.each([
      ["subscription", "none", "CLAUDE_CODE_OAUTH_TOKEN"],
      ["api-key", "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
    ] as const)("Scenario: Factory credentials do not reach the role session (%s mode)", async (authMode, apiKeySource, credential) => {
      const role = sampleRole({ authMode });
      const { env } = onlyOptions(await run([init(apiKeySource), success(VALID_RESULT)], { role, env: { ...PARENT_ENV, ...WORKER_SECRETS } }));
      for (const name of Object.keys(WORKER_SECRETS)) expect(env, name).not.toHaveProperty(name);
      const passed = JSON.stringify(env);
      for (const value of Object.values(WORKER_SECRETS)) expect(passed).not.toContain(value);
      expect(env?.[credential]).toBe(PARENT_ENV[credential]);
      if (authMode === "subscription") expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    });

    it("passes the allowlisted variables and nothing else, so a new variable does not leak by default", async () => {
      const allowlisted = {
        TMPDIR: "/tmp/factory",
        LC_ALL: "C.UTF-8",
        LC_CTYPE: "C.UTF-8",
        TZ: "UTC",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/rds.pem",
      };
      const parent = { ...PARENT_ENV, ...allowlisted, SOME_FUTURE_SECRET: "future-secret" };
      const { env } = onlyOptions(await run([init(), success(VALID_RESULT)], { env: parent }));
      expect(env).toMatchObject(allowlisted);
      expect(Object.keys(env ?? {}).sort()).toEqual(
        [...Object.keys(allowlisted), "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "LANG", "OPENSPEC_TELEMETRY", "PATH"].sort(),
      );
    });
  });

  describe("FACTORY_AUTH_MODE", () => {
    const overriding = (mode: string) => ({ ...PARENT_ENV, FACTORY_AUTH_MODE: mode });

    it("Scenario: Deployment overrides the configured mode", async () => {
      const result = await run([init("ANTHROPIC_API_KEY"), success(VALID_RESULT)], {
        role: sampleRole({ authMode: "subscription" }),
        env: overriding("api-key"),
      });
      expect(result.outcome).toEqual({ value: VALID_RESULT });
      const { env } = onlyOptions(result);
      expect(env?.["ANTHROPIC_API_KEY"]).toBe(PARENT_ENV.ANTHROPIC_API_KEY);
      expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      // The reported mode goes to the ledger through this message; factory/ledger/test/runner.test.ts follows it there.
      expect(result.recorder.entries[0]?.message).toMatchObject({ subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
    });

    it("overrides an api-key role to subscription too", async () => {
      const result = await run([init("none"), success(VALID_RESULT)], {
        role: sampleRole({ authMode: "api-key" }),
        env: overriding("subscription"),
      });
      expect(result.outcome).toEqual({ value: VALID_RESULT });
      const { env } = onlyOptions(result);
      expect(env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(PARENT_ENV.CLAUDE_CODE_OAUTH_TOKEN);
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    });

    it.each([
      ["subscription", "api-key", "none"],
      ["api-key", "subscription", "ANTHROPIC_API_KEY"],
    ] as const)("Scenario: Mismatched auth mode fails fast, against the override (config %s, override %s)", async (authMode, override, reported) => {
      const result = await run([init(reported), toolUse(), success(VALID_RESULT)], { role: sampleRole({ authMode }), env: overriding(override) });
      const error = failed(result.outcome);
      expect(error.reason).toBe("auth-mode-mismatch");
      expect(error.evidence).toContain(override);
      expect(onlyOptions(result).abortController?.signal.aborted).toBe(true);
      expect(result.pulled).toBe(1);
    });

    it.each(["bedrock", "API-KEY", ""])("fails the attempt before query() runs for the invalid value %j", async (value) => {
      const result = await run([init(), success(VALID_RESULT)], { env: overriding(value) });
      const error = failed(result.outcome);
      expect(error.reason).toBe("config");
      expect(error.evidence).toContain("FACTORY_AUTH_MODE");
      expect(result.calls).toEqual([]);
      expect(result.recorder.entries).toEqual([]);
    });
  });

  it("records every message in order under the work item and role, including those after the result", async () => {
    const steps = [init(), toolUse(), success(VALID_RESULT), idle()];
    const { recorder } = await run(steps);
    expect(recorder.entries).toEqual(steps.map((message) => ({ itemId: "item-1", role: "sample-role", message })));
  });

  describe("failure reasons", () => {
    it.each([
      ["error_max_turns", "max-turns"],
      ["error_max_budget_usd", "budget"],
      ["error_during_execution", "error"],
      ["error_max_structured_output_retries", "invalid-result"],
    ] as const)("maps the result subtype %s to %s, with the result's errors as evidence", async (subtype, reason) => {
      const { outcome } = await run([init(), failure(subtype, [`${subtype} happened`]), sdkThrow(subtype)]);
      const error = failed(outcome);
      expect(error.reason).toBe(reason);
      expect(error.evidence).toContain(`${subtype} happened`);
    });

    it("maps a success result flagged is_error to error", async () => {
      const error = failed((await run([init(), success(undefined, true)])).outcome);
      expect(error.reason).toBe("error");
      expect(error.evidence).toContain("API Error: 500");
    });

    it("maps a session that throws before any result to error, with the thrown message as evidence", async () => {
      const error = failed((await run([init(), new Error("spawn claude ENOENT")])).outcome);
      expect(error.reason).toBe("error");
      expect(error.evidence).toContain("spawn claude ENOENT");
    });

    it("maps a session that ends without a result to no-result", async () => {
      expect(failed((await run([init(), toolUse()])).outcome).reason).toBe("no-result");
    });

    it("does not report the error the SDK throws after an error result as a second failure", async () => {
      const steps = [init(), failure("error_max_turns"), sdkThrow("error_max_turns")];
      const { outcome, recorder } = await run(steps);
      const error = failed(outcome);
      expect(error.reason).toBe("max-turns");
      expect(error.evidence).not.toContain("Claude Code returned an error result");
      expect(recorder.entries.map((entry) => entry.message)).toEqual(steps.slice(0, 2));
    });

    it("gives invalid-result, with the schema issues as evidence, for structured output that fails the role's schema", async () => {
      const invalid = { changeId: CHANGE_ID, complexity: "huge", summary: "A sample change.", openQuestions: [] };
      const error = failed((await run([init(), success(invalid)])).outcome);
      expect(error.reason).toBe("invalid-result");
      expect(error.evidence).toContain("capabilities");
      expect(error.evidence).toContain("complexity");
    });

    it("gives invalid-result for a success result without structured output", async () => {
      expect(failed((await run([init(), success(undefined)])).outcome).reason).toBe("invalid-result");
    });

    it("gives invalid-change, with openspec's JSON output as evidence, when the change fails strict validation", async () => {
      rmSync(join(worktree, CHANGE, "specs"), { recursive: true });
      const error = failed((await run([init(), success(VALID_RESULT)])).outcome);
      expect(error.reason).toBe("invalid-change");
      const report = JSON.parse(error.evidence) as { items: { id: string; valid: boolean; issues: { message: string }[] }[] };
      expect(report.items).toEqual([expect.objectContaining({ id: CHANGE_ID, valid: false })]);
      expect(report.items[0]?.issues.map((issue) => issue.message).join("\n")).toContain("at least one delta");
    });
  });

  it("Scenario: Turn cap ends the attempt", async () => {
    const result = await run([init(), toolUse(), failure("error_max_turns"), sdkThrow("error_max_turns")], {
      role: sampleRole({ maxTurns: 5 }),
    });
    expect(onlyOptions(result).maxTurns).toBe(5);
    expect(failed(result.outcome).reason).toBe("max-turns");
    expect(result.recorder.entries.at(-1)?.message).toMatchObject({ type: "result", subtype: "error_max_turns" });
  });

  it("Scenario: Budget ends the attempt", async () => {
    const result = await run([init(), toolUse(), failure("error_max_budget_usd", [], 0.12), sdkThrow("error_max_budget_usd")], {
      role: sampleRole({ maxBudgetUsd: 0.1 }),
    });
    expect(onlyOptions(result).maxBudgetUsd).toBe(0.1);
    expect(failed(result.outcome).reason).toBe("budget");
    expect(result.recorder.entries.at(-1)?.message).toMatchObject({ type: "result", subtype: "error_max_budget_usd", total_cost_usd: 0.12 });
  });

  it("Scenario: Mismatched auth mode fails fast", async () => {
      const result = await run([init("none"), toolUse(), success(VALID_RESULT)], { role: sampleRole({ authMode: "api-key" }) });
      const error = failed(result.outcome);
      expect(error.reason).toBe("auth-mode-mismatch");
      expect(error.evidence).toContain("api-key");
      expect(error.evidence).toContain("none");
      // Aborted on the init message: the tool call that follows is never taken from the session.
      expect(onlyOptions(result).abortController?.signal.aborted).toBe(true);
      expect(result.pulled).toBe(1);
      // The reported mode is still recorded.
      expect(result.recorder.entries.map((entry) => entry.message)).toEqual([expect.objectContaining({ subtype: "init", apiKeySource: "none" })]);
  });

  it("fails a subscription role whose session reports an API key as an auth-mode mismatch", async () => {
    const result = await run([init("ANTHROPIC_API_KEY"), toolUse(), success(VALID_RESULT)]);
    expect(failed(result.outcome).reason).toBe("auth-mode-mismatch");
    expect(result.pulled).toBe(1);
  });
});
