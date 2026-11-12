import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { JsonlRecorder, replayMessages } from "../src/jsonl-recorder.ts";
import type { Recorder } from "../src/runner.ts";
import { init, success } from "./fake-session.ts";

class MemoryRecorder implements Recorder {
  readonly entries: { itemId: string; role: string; message: SDKMessage }[] = [];

  record(itemId: string, role: string, message: SDKMessage): Promise<void> {
    this.entries.push({ itemId, role, message });
    return Promise.resolve();
  }
}

describe("JsonlRecorder", () => {
  it("writes one JSON line per message, in order, ending with a newline", async () => {
    const messages = [init(), success({ summary: "Done.", notes: "a\nmultiline note" })];
    const recorder = new JsonlRecorder();
    for (const message of messages) await recorder.record("item-1", "implementer", message);

    const jsonl = recorder.toJsonl();
    expect(jsonl.endsWith("\n")).toBe(true);
    const lines = jsonl.slice(0, -1).split("\n");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(messages);
  });

  it("is empty before any message", () => {
    expect(new JsonlRecorder().toJsonl()).toBe("");
  });
});

describe("replayMessages", () => {
  it("records every message, in order, under the given work item and role, and returns the count", async () => {
    const messages = [init(), success({ summary: "Done.", notes: "" })];
    const source = new JsonlRecorder();
    for (const message of messages) await source.record("build", "implementer", message);
    const target = new MemoryRecorder();

    expect(await replayMessages(source.toJsonl(), "item-9", "implementer", target)).toBe(2);
    expect(target.entries).toEqual(messages.map((message) => ({ itemId: "item-9", role: "implementer", message })));
  });

  it("replays nothing from an empty file", async () => {
    const target = new MemoryRecorder();
    expect(await replayMessages("", "item-9", "implementer", target)).toBe(0);
    expect(target.entries).toEqual([]);
  });

  it("rejects a line that is not a JSON message, naming its line number, and records nothing", async () => {
    const target = new MemoryRecorder();
    const jsonl = `${JSON.stringify(init())}\nnot json\n`;
    await expect(replayMessages(jsonl, "item-9", "implementer", target)).rejects.toThrow(/line 2/);
    await expect(replayMessages('{"no":"type"}\n', "item-9", "implementer", target)).rejects.toThrow(/line 1/);
    expect(target.entries).toEqual([]);
  });
});
