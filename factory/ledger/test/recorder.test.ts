import type { Recorder } from "@vocab/factory-roles";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { closeAttempt, createWorkItem, listAttempts, listMessages, openAttempt } from "../src/queries.ts";
import { extractUsage, LedgerRecorder } from "../src/recorder.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { assistant, init, result } from "./messages.ts";

const ROLE = "proposal-author";

let db: TestDatabase;
let nextIssue = 1;

beforeAll(async () => {
  db = await createTestDatabase("recorder");
  await migrate(db.pool);
  return () => db.close();
});

async function newWorkItem(): Promise<string> {
  const issueNumber = nextIssue++;
  const item = await createWorkItem(db.pool, { issueNumber, changeId: `add-item-${String(issueNumber)}`, branch: `add-item-${String(issueNumber)}`, state: "proposal" });
  return item.id;
}

describe("extractUsage", () => {
  it("reads token usage from assistant and result messages, and none from others", () => {
    const tokens = { input: 100, output: 20, cacheRead: 300, cacheCreation: 40 };
    const expected = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 40 };

    expect(extractUsage(assistant(tokens))).toEqual(expected);
    expect(extractUsage(result(tokens, 0.01))).toEqual(expected);
    expect(extractUsage(init("none"))).toBeUndefined();
  });
});

describe("LedgerRecorder", () => {
  it("is the role runner's Recorder", () => {
    const recorder: Recorder = new LedgerRecorder(db.pool);
    expect(typeof recorder.record).toBe("function");
  });

  it("stores every SDK message of the open attempt in order, with its token usage", async () => {
    const workItemId = await newWorkItem();
    const attempt = await openAttempt(db.pool, { workItemId, state: "proposal", role: ROLE });
    const recorder = new LedgerRecorder(db.pool);
    const messages = [
      init("none"),
      assistant({ input: 100, output: 20, cacheRead: 300, cacheCreation: 40 }),
      result({ input: 250, output: 80, cacheRead: 900, cacheCreation: 40 }, 0.0123),
    ];

    for (const message of messages) await recorder.record(workItemId, ROLE, message);

    const stored = await listMessages(db.pool, attempt.id);
    expect(stored.map(({ seq, type, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }) => ({ seq, type, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }))).toEqual([
      { seq: 1, type: "system", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
      { seq: 2, type: "assistant", inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 40 },
      { seq: 3, type: "result", inputTokens: 250, outputTokens: 80, cacheReadTokens: 900, cacheCreationTokens: 40 },
    ]);
    expect(stored.map((message) => message.raw)).toEqual(messages);
    expect(stored.every((message) => message.attemptId === attempt.id)).toBe(true);
  });

  it("records the reported auth mode and the estimated cost on the attempt", async () => {
    const subscriptionItem = await newWorkItem();
    const apiKeyItem = await newWorkItem();
    await openAttempt(db.pool, { workItemId: subscriptionItem, state: "proposal", role: ROLE });
    await openAttempt(db.pool, { workItemId: apiKeyItem, state: "proposal", role: ROLE });
    const recorder = new LedgerRecorder(db.pool);
    const tokens = { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 };

    await recorder.record(subscriptionItem, ROLE, init("none"));
    await recorder.record(subscriptionItem, ROLE, result(tokens, 0.42));
    await recorder.record(apiKeyItem, ROLE, init("ANTHROPIC_API_KEY"));

    expect(await listAttempts(db.pool, subscriptionItem)).toMatchObject([{ authMode: "subscription", costUsdEstimate: 0.42 }]);
    expect(await listAttempts(db.pool, apiKeyItem)).toMatchObject([{ authMode: "api-key", costUsdEstimate: null }]);
  });

  it("rejects a message when the work item has no open attempt for the role", async () => {
    const workItemId = await newWorkItem();
    const recorder = new LedgerRecorder(db.pool);

    await expect(recorder.record(workItemId, ROLE, init("none"))).rejects.toThrow(/no open attempt/);

    const attempt = await openAttempt(db.pool, { workItemId, state: "proposal", role: ROLE });
    await expect(recorder.record(workItemId, "architect", init("none"))).rejects.toThrow(/no open attempt/);
    await closeAttempt(db.pool, attempt.id, { outcome: "succeeded" });
    await expect(recorder.record(workItemId, ROLE, init("none"))).rejects.toThrow(/no open attempt/);
    expect(await listMessages(db.pool, attempt.id)).toEqual([]);
  });
});
