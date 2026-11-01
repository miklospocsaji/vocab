/**
 * The role runner's Recorder, backed by the ledger. Each SDK message goes into the open
 * attempt of the work item and role, in arrival order, with its token usage. The init
 * message sets the attempt's auth mode (ADR 0006); the result message sets its estimated cost.
 * The orchestrator opens the attempt before running the role and closes it afterwards.
 */
import type { ApiKeySource, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Recorder } from "@vocab/factory-roles";
import type { Db } from "./db.ts";
import type { AuthMode } from "./queries.ts";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** The mode each `apiKeySource` means, matching the role runner's check; others are left unknown. */
const AUTH_MODES: Partial<Record<ApiKeySource, AuthMode>> = {
  ANTHROPIC_API_KEY: "api-key",
  none: "subscription",
};

/**
 * Token usage of an assistant message (that API call) or a result message (the whole
 * session's total, so per-attempt totals come from result messages alone); none otherwise.
 */
export function extractUsage(message: SDKMessage): TokenUsage | undefined {
  let usage;
  if (message.type === "assistant") usage = message.message.usage;
  else if (message.type === "result") usage = message.usage;
  else return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export class LedgerRecorder implements Recorder {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Rejects when the work item has no open attempt for the role. */
  async record(itemId: string, role: string, message: SDKMessage): Promise<void> {
    const { rows } = await this.#db.query<{ id: string }>(
      "SELECT id FROM attempts WHERE work_item_id = $1 AND role = $2 AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
      [itemId, role],
    );
    const attemptId = rows[0]?.id;
    if (attemptId === undefined) throw new Error(`no open attempt for work item ${itemId} and role ${role}`);

    const usage = extractUsage(message);
    await this.#db.query(
      `INSERT INTO messages (attempt_id, seq, type, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw)
       SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5, $6, $7 FROM messages WHERE attempt_id = $1`,
      [
        attemptId,
        message.type,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.cacheReadTokens ?? null,
        usage?.cacheCreationTokens ?? null,
        JSON.stringify(message),
      ],
    );

    if (message.type === "system" && message.subtype === "init") {
      await this.#db.query("UPDATE attempts SET auth_mode = $2 WHERE id = $1", [attemptId, AUTH_MODES[message.apiKeySource] ?? null]);
    } else if (message.type === "result") {
      await this.#db.query("UPDATE attempts SET cost_usd_estimate = $2 WHERE id = $1", [attemptId, message.total_cost_usd]);
    }
  }
}
