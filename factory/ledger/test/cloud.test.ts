/**
 * Migration 0002 and its queries (add-cloud-proposal-run task 2.5): the execution ARN and a
 * unique issue number per work item, approvals with their task tokens, and results on attempts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import {
  ApprovalAlreadyOpen,
  closeApproval,
  closeAttempt,
  createWorkItem,
  findOpenApproval,
  findWorkItemByIssue,
  IssueHasWorkItem,
  listAttempts,
  openApproval,
  openAttempt,
  reopenApproval,
} from "../src/queries.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

const OWNER = "miklospocsaji";
const ARN = "arn:aws:states:eu-central-1:123456789012:execution:factory-work-item:issue-12-4f0c";
const TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAQ-task-token";

let db: TestDatabase;
let nextIssue = 100;

beforeAll(async () => {
  db = await createTestDatabase("cloud");
  await migrate(db.pool);
  return () => db.close();
});

async function newWorkItem(executionArn?: string): Promise<{ id: string; issueNumber: number }> {
  const issueNumber = nextIssue++;
  const changeId = `add-item-${String(issueNumber)}`;
  const item = await createWorkItem(db.pool, {
    issueNumber,
    changeId,
    branch: changeId,
    state: "awaiting-proposal-approval",
    ...(executionArn === undefined ? {} : { executionArn }),
  });
  return { id: item.id, issueNumber };
}

describe("work items in the cloud", () => {
  it("keeps the issue number unique", async () => {
    const { issueNumber } = await newWorkItem();

    const second = createWorkItem(db.pool, { issueNumber, changeId: "add-other-name", branch: "add-other-name", state: "intake" });

    await expect(second).rejects.toThrow(IssueHasWorkItem);
    await expect(second).rejects.toThrow(`#${String(issueNumber)}`);
    expect((await findWorkItemByIssue(db.pool, issueNumber))?.changeId).toBe(`add-item-${String(issueNumber)}`);
  });

  it("records the execution ARN on the work item", async () => {
    const { issueNumber } = await newWorkItem(ARN);
    expect(await findWorkItemByIssue(db.pool, issueNumber)).toMatchObject({ executionArn: ARN });

    // A local run has no execution.
    const local = await newWorkItem();
    expect(await findWorkItemByIssue(db.pool, local.issueNumber)).toMatchObject({ executionArn: null });
  });
});

describe("approvals", () => {
  it("stores an open approval with its task token", async () => {
    const item = await newWorkItem(ARN);

    const approval = await openApproval(db.pool, { workItemId: item.id, taskToken: TOKEN });

    expect(approval).toMatchObject({ workItemId: item.id, state: "open", taskToken: TOKEN, resolvedAt: null, resolvedBy: null });
    expect(approval.requestedAt).toBeInstanceOf(Date);
    expect(await findOpenApproval(db.pool, item.id)).toEqual(approval);
  });

  it("allows one open approval per work item", async () => {
    const item = await newWorkItem(ARN);
    const other = await newWorkItem(ARN);
    await openApproval(db.pool, { workItemId: item.id, taskToken: TOKEN });

    await expect(openApproval(db.pool, { workItemId: item.id, taskToken: `${TOKEN}-2` })).rejects.toThrow(ApprovalAlreadyOpen);
    // Another work item's approval is independent.
    await expect(openApproval(db.pool, { workItemId: other.id, taskToken: TOKEN })).resolves.toMatchObject({ state: "open" });
  });

  it("closes the open approval with resolved_by, once", async () => {
    const item = await newWorkItem(ARN);
    const opened = await openApproval(db.pool, { workItemId: item.id, taskToken: TOKEN });

    const closed = await closeApproval(db.pool, item.id, OWNER);

    expect(closed).toMatchObject({ id: opened.id, state: "closed", taskToken: TOKEN, resolvedBy: OWNER });
    expect(closed?.resolvedAt).toBeInstanceOf(Date);
    expect(await findOpenApproval(db.pool, item.id)).toBeUndefined();
    // Nothing is open any more, so a second /approve closes nothing.
    expect(await closeApproval(db.pool, item.id, OWNER)).toBeUndefined();
  });

  it("closes atomically when two approvals race", async () => {
    const item = await newWorkItem(ARN);
    await openApproval(db.pool, { workItemId: item.id, taskToken: TOKEN });

    const results = await Promise.all([closeApproval(db.pool, item.id, OWNER), closeApproval(db.pool, item.id, OWNER)]);

    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it("reopens a closed approval, and then allows a new close", async () => {
    const item = await newWorkItem(ARN);
    const opened = await openApproval(db.pool, { workItemId: item.id, taskToken: TOKEN });
    await closeApproval(db.pool, item.id, OWNER);

    const reopened = await reopenApproval(db.pool, opened.id);

    expect(reopened).toMatchObject({ id: opened.id, state: "open", taskToken: TOKEN, resolvedAt: null, resolvedBy: null });
    expect(await findOpenApproval(db.pool, item.id)).toEqual(reopened);
    await expect(closeApproval(db.pool, item.id, OWNER)).resolves.toMatchObject({ id: opened.id, state: "closed" });
  });

  it("refuses to reopen an approval while another is open", async () => {
    const item = await newWorkItem(ARN);
    const first = await openApproval(db.pool, { workItemId: item.id, taskToken: TOKEN });
    await closeApproval(db.pool, item.id, OWNER);
    await openApproval(db.pool, { workItemId: item.id, taskToken: `${TOKEN}-2` });

    await expect(reopenApproval(db.pool, first.id)).rejects.toThrow(ApprovalAlreadyOpen);
  });
});

describe("results on attempts", () => {
  const RESULT = { changeId: "add-item", capabilities: ["vocab-import"], complexity: "small", summary: "Import.", openQuestions: [] };

  it("stores a succeeded attempt's result, and none on a failed one", async () => {
    const item = await newWorkItem();
    const failed = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });
    await closeAttempt(db.pool, failed.id, { outcome: "failed", failureReason: "invalid-change" });
    const succeeded = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });

    const closed = await closeAttempt(db.pool, succeeded.id, { outcome: "succeeded", result: RESULT });

    expect(closed.result).toEqual(RESULT);
    expect((await listAttempts(db.pool, item.id)).map((attempt) => attempt.result)).toEqual([null, RESULT]);
  });

  it("leaves the result empty when a succeeded attempt has none", async () => {
    const item = await newWorkItem();
    const attempt = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });

    expect((await closeAttempt(db.pool, attempt.id, { outcome: "succeeded" })).result).toBeNull();
  });

  it("refuses a result on a failed attempt", async () => {
    const item = await newWorkItem();
    const attempt = await openAttempt(db.pool, { workItemId: item.id, state: "proposal", role: "proposal-author" });

    await expect(
      db.pool.query("UPDATE attempts SET ended_at = now(), outcome = 'failed', failure_reason = 'error', result = '{}' WHERE id = $1", [attempt.id]),
    ).rejects.toThrow(/check constraint/);
  });
});
