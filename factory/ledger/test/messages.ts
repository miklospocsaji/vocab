// SDK messages shaped like SDK 0.3.310's (sdk.d.ts), as the role runner tests build them.
import { randomUUID } from "node:crypto";
import type {
  ApiKeySource,
  NonNullableUsage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";

const MODEL = "claude-opus-5-5";
const SESSION = "session-1";

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function usage(tokens: Tokens): NonNullableUsage {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: tokens.cacheCreation },
    cache_creation_input_tokens: tokens.cacheCreation,
    cache_read_input_tokens: tokens.cacheRead,
    fallback_credit: null,
    inference_geo: "",
    input_tokens: tokens.input,
    iterations: [],
    output_tokens: tokens.output,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  };
}

export function init(apiKeySource: ApiKeySource): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource,
    claude_code_version: "2.3.310",
    cwd: "/worktree",
    tools: ["Read", "Write"],
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

export function assistant(tokens: Tokens): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_1",
      container: null,
      content: [{ type: "text", text: "Writing the proposal.", citations: null }],
      context_management: null,
      diagnostics: null,
      model: MODEL,
      role: "assistant",
      stop_details: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      usage: usage(tokens),
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

/** The result message: its usage is the session's total, its cost the SDK's estimate. */
export function result(tokens: Tokens, totalCostUsd: number): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 2,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: totalCostUsd,
    usage: usage(tokens),
    modelUsage: {
      [MODEL]: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadInputTokens: tokens.cacheRead,
        cacheCreationInputTokens: tokens.cacheCreation,
        webSearchRequests: 0,
        costUSD: totalCostUsd,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    permission_denials: [],
    structured_output: {},
    uuid: randomUUID(),
    session_id: SESSION,
  };
}
