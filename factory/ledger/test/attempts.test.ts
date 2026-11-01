import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { closeAttempt, createWorkItem, listAttempts, openAttempt, workItemCost } from "../src/queries.ts";
import { LedgerRecorder } from "../src/recorder.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { result } from "./messages.ts";

const ROLE = "proposal-author";
const TOKENS = { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 };

let db: TestDatabase;
let nextIssue = 1;

beforeAll(async () => {
  db = await createTestDatabase("attempts");
  await migrate(db.pool);
  return () => db.close();
});

async function newWorkItem(): Promise<string> {
  const issueNumber = nextIssue++;
  const item = await createWorkItem(db.pool, { issueNumber, changeId: `add-item-${String(issueNumber)}`, branch: `add-item-${String(issueNumber)}`, state: "proposal" });
  return item.id;
}

/** One failed attempt whose session reported `costUsd`, or no result at all. */
async function attemptCosting(workItemId: string, costUsd: number | undefined): Promise<void> {
  const attempt = await openAttempt(db.pool, { workItemId, state: "proposal", role: ROLE });
  if (costUsd !== undefined) await new LedgerRecorder(db.pool).record(workItemId, ROLE, result(TOKENS, costUsd));
  await closeAttempt(db.pool, attempt.id, { outcome: "failed", failureReason: "invalid-change" });
}

describe("attempts", () => {
  it("opens and closes attempts with an outcome and failure reason", async () => {
    const workItemId = await newWorkItem();

    const first = await openAttempt(db.pool, { workItemId, state: "proposal", role: ROLE });
    expect(first).toMatchObject({
      workItemId,
      state: "proposal",
      role: ROLE,
      n: 1,
      endedAt: null,
      outcome: null,
      failureReason: null,
      authMode: null,
      costUsdEstimate: null,
    });
    expect(first.startedAt).toBeInstanceOf(Date);

    const failed = await closeAttempt(db.pool, first.id, { outcome: "failed", failureReason: "invalid-change" });
    expect(failed).toMatchObject({ id: first.id, outcome: "failed", failureReason: "invalid-change" });
    expect(failed.endedAt).toBeInstanceOf(Date);
    expect(failed.endedAt?.getTime()).toBeGreaterThanOrEqual(first.startedAt.getTime());

    const second = await openAttempt(db.pool, { workItemId, state: "proposal", role: ROLE });
    expect(second.n).toBe(2);
    const succeeded = await closeAttempt(db.pool, second.id, { outcome: "succeeded" });
    expect(succeeded).toMatchObject({ outcome: "succeeded", failureReason: null });

    expect(await listAttempts(db.pool, workItemId)).toEqual([failed, succeeded]);
  });

  it("numbers attempts per work item and state", async () => {
    const workItemId = await newWorkItem();
    const otherItem = await newWorkItem();

    await openAttempt(db.pool, { workItemId: otherItem, state: "proposal", role: ROLE });
    const proposal = await openAttempt(db.pool, { workItemId, state: "proposal", role: ROLE });
    const design = await openAttempt(db.pool, { workItemId, state: "design", role: "architect" });

    expect([proposal.n, design.n]).toEqual([1, 1]);
  });

  it("sums a work item's estimated cost over its attempts", async () => {
    const workItemId = await newWorkItem();
    const otherItem = await newWorkItem();

    await attemptCosting(workItemId, 0.5);
    await attemptCosting(workItemId, 0.25);
    await attemptCosting(workItemId, undefined);
    await attemptCosting(otherItem, 9);

    expect(await workItemCost(db.pool, workItemId)).toBe(0.75);
  });

  it("reports zero cost for a work item without attempts", async () => {
    expect(await workItemCost(db.pool, await newWorkItem())).toBe(0);
  });
});
