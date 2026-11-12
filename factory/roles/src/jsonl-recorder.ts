/**
 * The build container's Recorder (add-build-roles design.md): it has no ledger, so each SDK
 * message becomes one JSON line of `messages.jsonl` in the artifact store. The worker replays
 * the file through the LedgerRecorder, which then stores what a live recording would.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Recorder } from "./runner.ts";

export class JsonlRecorder implements Recorder {
  readonly #lines: string[] = [];

  /** The work item and role are the caller's, so the line holds the message alone. */
  record(_itemId: string, _role: string, message: SDKMessage): Promise<void> {
    this.#lines.push(JSON.stringify(message));
    return Promise.resolve();
  }

  /** The messages so far, one per line, each line ending with a newline. */
  toJsonl(): string {
    return this.#lines.map((line) => `${line}\n`).join("");
  }
}

/**
 * Records each message of `jsonl`, in order, under the work item and role, and returns how many
 * there were. The whole file is parsed first, so a bad line records nothing.
 */
export async function replayMessages(jsonl: string, itemId: string, role: string, recorder: Recorder): Promise<number> {
  const messages: SDKMessage[] = [];
  const lines = jsonl.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`messages.jsonl line ${String(index + 1)} is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
      throw new Error(`messages.jsonl line ${String(index + 1)} is not an SDK message`);
    }
    messages.push(parsed as SDKMessage);
  }
  for (const message of messages) await recorder.record(itemId, role, message);
  return messages.length;
}
