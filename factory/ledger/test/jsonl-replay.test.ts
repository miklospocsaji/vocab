// The build container records a session to messages.jsonl; the worker replays it into the ledger
// (add-build-roles task 2.10). The replay must give the rows a live recording gives.
import { JsonlRecorder, replayMessages } from "@vocab/factory-roles";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { createWorkItem, listAttempts, listMessages, openAttempt } from "../src/queries.ts";
import { LedgerRecorder } from "../src/recorder.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { assistant, init, result } from "./messages.ts";

const ROLE = "implementer";

let db: TestDatabase;
let nextIssue = 1;

beforeAll(async () => {
  db = await createTestDatabase("jsonl_replay");
  await migrate(db.pool);
  return () => db.close();
});

async function openItem(): Promise<{ workItemId: string; attemptId: string }> {
  const issueNumber = nextIssue++;
  const row = await createWorkItem(db.pool, { issueNumber, changeId: `add-item-${String(issueNumber)}`, branch: `add-item-${String(issueNumber)}`, state: "build" });
  const attempt = await openAttempt(db.pool, { workItemId: row.id, state: "build", role: ROLE });
  return { workItemId: row.id, attemptId: attempt.id };
}

describe("messages.jsonl", () => {
  it("replays through LedgerRecorder to the same rows as a live recording", async () => {
    const messages = [
      init("ANTHROPIC_API_KEY"),
      assistant({ input: 100, output: 20, cacheRead: 300, cacheCreation: 40 }),
      result({ input: 250, output: 80, cacheRead: 900, cacheCreation: 40 }, 0.0456),
    ];

    const live = await openItem();
    const ledger = new LedgerRecorder(db.pool);
    for (const message of messages) await ledger.record(live.workItemId, ROLE, message);

    const replayed = await openItem();
    const jsonl = new JsonlRecorder();
    for (const message of messages) await jsonl.record("build-container", ROLE, message);
    expect(await replayMessages(jsonl.toJsonl(), replayed.workItemId, ROLE, ledger)).toBe(messages.length);

    const rows = async (attemptId: string) =>
      (await listMessages(db.pool, attemptId)).map(({ seq, type, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, raw }) => ({
        seq,
        type,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        raw,
      }));
    expect(await rows(replayed.attemptId)).toEqual(await rows(live.attemptId));
    expect(await rows(live.attemptId)).toHaveLength(3);

    const attempt = async (workItemId: string) => (await listAttempts(db.pool, workItemId)).map(({ authMode, costUsdEstimate }) => ({ authMode, costUsdEstimate }));
    expect(await attempt(replayed.workItemId)).toEqual(await attempt(live.workItemId));
    expect(await attempt(live.workItemId)).toEqual([{ authMode: "api-key", costUsdEstimate: 0.0456 }]);
  });
});
