// SDK messages shaped like SDK 0.3.310's (sdk.d.ts), and a fake `query` whose "session" can act
// on the worktree (as Bash or agent-run code would) before it returns its result.
import { randomUUID } from "node:crypto";
import type { ApiKeySource, NonNullableUsage, Options, SDKMessage, SDKResultSuccess, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../src/runner.ts";

const MODEL = "claude-sonnet-5-5";
const SESSION = "session-1";

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

export function init(apiKeySource: ApiKeySource = "none"): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource,
    claude_code_version: "2.3.310",
    cwd: "/worktree",
    tools: [],
    mcp_servers: [],
    model: MODEL,
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

export function success(structuredOutput: unknown): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 2,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage,
    modelUsage: {
      [MODEL]: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.01,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    permission_denials: [],
    structured_output: structuredOutput,
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

export interface FakeQuery {
  query: QueryFn;
  calls: { prompt: string; options: Options }[];
}

/** A `query` that yields the init message, runs `act` with the session's options, then yields `result`. */
export function fakeQuery(result: SDKMessage, act: (options: Options) => void | Promise<void> = () => undefined): FakeQuery {
  const calls: FakeQuery["calls"] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    return (async function* () {
      yield init();
      await act(params.options);
      yield result;
    })();
  };
  return { query, calls };
}
