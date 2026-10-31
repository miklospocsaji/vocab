/**
 * Shared setup for the live boundary tests (`*.live.test.ts`): a temp worktree, a throwaway
 * role written into it and loaded through `loadRole`, one real runner attempt with an
 * in-memory recorder, and helpers that read the recorded messages back.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { stringify } from "yaml";
import { loadRole, type Role, type RoleConfig } from "../src/config.ts";
import { AttemptFailed, createRunner, type Recorder } from "../src/runner.ts";

export const LIVE_MODEL = "claude-haiku-5-5";
export const LIVE_BUDGET_USD = 0.1;
export const CHANGE_ID = "add-boundary-probe";
export const CHANGE = `openspec/changes/${CHANGE_ID}`;

/** The result every probe role returns, so a structured output exists to end the session. */
const PROBE_RESULT = JSON.stringify({
  changeId: CHANGE_ID,
  capabilities: ["roles"],
  complexity: "small",
  summary: "Boundary probe.",
  openQuestions: [],
});

/** A temp directory standing in for a work item's worktree; realpath'd so paths compare. */
export function makeWorktree(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "vocab-live-")));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function writeFile(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export interface ProbeRole {
  name: string;
  tools: string[];
  allow: string[];
  writable: string[];
  /** What the role must try, in the role's own (trusted) system prompt. */
  task: string;
}

/**
 * Writes a throwaway role into the worktree (`factory/roles/<name>.yaml` and
 * `.claude/agents/<name>.md`) and loads it with `loadRole`, as the factory would.
 */
export async function writeProbeRole(worktree: string, probe: ProbeRole): Promise<Role> {
  const config: RoleConfig = {
    name: probe.name,
    model: LIVE_MODEL,
    tools: probe.tools,
    allow: probe.allow,
    writable: probe.writable,
    skills: [],
    maxTurns: 8,
    maxBudgetUsd: LIVE_BUDGET_USD,
    resultSchema: "proposal-result",
    authMode: "subscription",
  };
  writeFile(worktree, `factory/roles/${probe.name}.yaml`, stringify(config));
  writeFile(
    worktree,
    `.claude/agents/${probe.name}.md`,
    [
      "---",
      `name: ${probe.name}`,
      "description: Throwaway role for a live boundary test.",
      "---",
      "",
      "You are a probe role in an automated test of an agent harness's file-write boundaries.",
      "The harness is expected to deny the action below; the test checks that the denial happens.",
      "You must actually make the tool call described: do not skip it, ask about it or refuse it.",
      "",
      "Your task:",
      probe.task,
      "",
      "Make that call exactly once. If it is denied or fails, do not retry it and do not try any",
      "other path or tool. Then finish by returning exactly this structured result:",
      PROBE_RESULT,
      "",
    ].join("\n"),
  );
  return loadRole(probe.name, { root: worktree });
}

export interface LiveAttempt {
  messages: SDKMessage[];
  result: SDKResultMessage | undefined;
  /** The runner's outcome: the parsed result, or the AttemptFailed it threw. */
  outcome: unknown;
  costUsd: number;
}

/** One real runner attempt for the probe role; every message the recorder saw is kept. */
export async function runProbe(role: Role, worktree: string): Promise<LiveAttempt> {
  const messages: SDKMessage[] = [];
  const recorder: Recorder = {
    record: (_itemId, _role, message) => {
      messages.push(message);
      return Promise.resolve();
    },
  };
  const runRole = createRunner({ recorder });
  let outcome: unknown;
  try {
    outcome = await runRole(role, {
      id: `live-${role.name}`,
      changeId: CHANGE_ID,
      worktree,
      issue: { title: "Boundary probe", body: "Follow your role instructions." },
      changeFiles: [],
      specs: [],
    });
  } catch (error) {
    if (!(error instanceof AttemptFailed)) throw error;
    outcome = error;
  }
  const result = messages.findLast((message): message is SDKResultMessage => message.type === "result");
  return { messages, result, outcome, costUsd: result?.total_cost_usd ?? 0 };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The tool calls the model made, in order. */
export function toolCalls(messages: SDKMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const block of message.message.content) {
      if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
    }
  }
  return calls;
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
}

/** The tool result the session returned to the model for one call. */
export function toolOutcome(messages: SDKMessage[], toolUseId: string): ToolOutcome | undefined {
  for (const message of messages) {
    if (message.type !== "user" || typeof message.message.content === "string") continue;
    for (const block of message.message.content) {
      if (block.type !== "tool_result" || block.tool_use_id !== toolUseId) continue;
      const content = block.content;
      const text =
        typeof content === "string"
          ? content
          : (content ?? []).map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
      return { isError: block.is_error === true, text };
    }
  }
  return undefined;
}

/** The calls of the given file tools whose target resolves (lexically) to `path` in the worktree. */
export function writeAttempts(messages: SDKMessage[], worktree: string, path: string): ToolCall[] {
  const wanted = resolve(worktree, path);
  return toolCalls(messages).filter((call) => {
    if (!["Write", "Edit", "NotebookEdit"].includes(call.name)) return false;
    const target = call.name === "NotebookEdit" ? call.input["notebook_path"] : call.input["file_path"];
    if (typeof target !== "string") return false;
    return resolve(worktree, target) === wanted;
  });
}
