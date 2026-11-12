// Complexity routing, Design and the owner's design approval (add-build-loop task 3.5).
import { findOpenApproval, findWorkItemByIssue, LedgerRecorder, listAttempts, type WorkItemRow } from "@vocab/factory-ledger";
import { loadRole, renderPrompt, type Role } from "@vocab/factory-roles";
import { beforeAll, describe, expect, it } from "vitest";
import { approved, awaitApproval } from "../src/approval.ts";
import { design, MAX_DESIGN_ATTEMPTS, type DesignContext } from "../src/design.ts";
import { changeFileReader } from "../src/git.ts";
import { DESIGN_APPROVAL_INSTRUCTION } from "../src/summary.ts";
import { createFakeRoleRunner, type FakeStep } from "./fake-role-runner.ts";
import { BOT, CHANGE, changedFiles, git, identityOf, ISSUE, proposedWorkItem, remoteHead, SPEC, useWorkItemFixture } from "./work-item-fixture.ts";

const f = useWorkItemFixture("design");

const TOKEN = "AQB8AAAAKgAAAAMAAAAAAAAAAeDesignToken";

const DESIGN_MD = ["# Design", "", "## Overview", "", "Read vocab.db with node:sqlite and map each lookup to a word.", ""].join("\n");
const DESIGN_MD_2 = ["# Design", "", "## Overview", "", "Read vocab.db with node:sqlite; merge duplicate lookups by word and book.", ""].join("\n");
const DESIGN_RESULT = {
  summary: "Read vocab.db with node:sqlite and map each lookup to a word.",
  contracts: ["app/contracts/src/lookup.ts"],
  adrNeeded: ["0013: node:sqlite for reading vocab.db"],
  openQuestions: [],
};

const architectStep = (content = DESIGN_MD): FakeStep => ({ files: { "design.md": content }, result: DESIGN_RESULT });
const APPROVE: FakeStep = { result: { verdict: "approve", findings: [] } };
const finding = (summary: string) => ({ severity: "blocker", location: "design.md#Overview", summary });
const changesRequested = (summary: string): FakeStep => ({ result: { verdict: "changes-requested", findings: [finding(summary)] } });

const BLOCKER = "The design never says how duplicate lookups are merged.";

let architect: Role;
let designReviewer: Role;

beforeAll(async () => {
  architect = await loadRole("architect");
  designReviewer = await loadRole("design-reviewer");
});

function approvedContext() {
  return { db: f.db.pool, forge: f.forge, readChangeFile: changeFileReader({ repo: f.repo, home: f.home }) };
}

function designContext(steps: FakeStep[]): { ctx: DesignContext; calls: ReturnType<typeof createFakeRoleRunner>["calls"] } {
  const fake = createFakeRoleRunner(new LedgerRecorder(f.db.pool), steps);
  return {
    ctx: { db: f.db.pool, forge: f.forge, runRole: fake.runRole, architect, designReviewer, repo: f.repo, home: f.home, committer: BOT },
    calls: fake.calls,
  };
}

/** A proposal of the given complexity, approved by the owner and through Approved. */
async function approvedWorkItem(complexity: string): Promise<WorkItemRow> {
  const transition = await approved(approvedContext(), await proposedWorkItem(f, complexity));
  if (transition.kind !== "advance") throw new Error(`approved did not advance: ${JSON.stringify(transition)}`);
  return transition.workItem;
}

describe("Approved routes on x-complexity", { timeout: 30_000 }, () => {
  it("Scenario: Small change skips Design", async () => {
    const workItem = await proposedWorkItem(f, "small");
    const comments = f.forge.comments.length;

    const transition = await approved(approvedContext(), workItem);

    // Approved goes straight to Plan: no architect or design reviewer could have run.
    expect(transition).toMatchObject({ kind: "advance", route: "plan", workItem: { state: "proposal-approved" } });
    expect(f.forge.comments).toHaveLength(comments + 1);
    expect(f.forge.comments.at(-1)?.body).toContain("proposal-approved");

    // Design refuses a small change, so the route cannot pass through it.
    const { ctx, calls } = designContext([architectStep()]);
    await expect(design(ctx, (await findWorkItemByIssue(f.db.pool, ISSUE.number)) as WorkItemRow)).rejects.toThrow(/small/);
    expect(calls).toEqual([]);
    expect((await listAttempts(f.db.pool, workItem.id)).map((attempt) => attempt.role)).toEqual(["proposal-author"]);
  });

  it("routes medium and large changes to Design, and a retry of Approved gives the same route without a second comment", async () => {
    const workItem = await proposedWorkItem(f, "large");

    const first = await approved(approvedContext(), workItem);
    const comments = f.forge.comments.length;
    const again = await approved(approvedContext(), (await findWorkItemByIssue(f.db.pool, ISSUE.number)) as WorkItemRow);

    expect(first).toMatchObject({ kind: "advance", route: "design", workItem: { state: "proposal-approved" } });
    expect(again).toMatchObject({ kind: "advance", route: "design", workItem: { state: "proposal-approved" } });
    expect(f.forge.comments).toHaveLength(comments);
  });

  it("escalates an unknown x-complexity", async () => {
    const workItem = await proposedWorkItem(f, "huge");

    const transition = await approved(approvedContext(), workItem);

    const stored = await findWorkItemByIssue(f.db.pool, ISSUE.number);
    expect(stored?.state).toBe("escalated");
    expect(transition).toEqual({ kind: "escalate", workItem: stored, reason: expect.stringContaining("x-complexity") as unknown });
    expect(f.forge.comments.at(-1)?.body).toContain("x-complexity");
    expect(f.forge.comments.at(-1)?.body).toContain("huge");
  });
});

describe("design", { timeout: 30_000 }, () => {
  it("Scenario: Medium change gets the agent review", async () => {
    const workItem = await approvedWorkItem("medium");
    const before = remoteHead(f);
    const { ctx, calls } = designContext([architectStep(), APPROVE]);

    const transition = await design(ctx, workItem);

    const stored = await findWorkItemByIssue(f.db.pool, ISSUE.number);
    expect(stored?.state).toBe("plan");
    expect(transition).toMatchObject({ kind: "advance", route: "plan", workItem: { state: "plan" } });

    // The reviewer runs after the architect, in a session of its own, on the design just written.
    expect(calls.map((call) => call.role)).toEqual(["architect", "design-reviewer"]);
    expect(calls[1]?.evidence).toBeUndefined();
    expect(calls[1]?.item.prompt).toBeUndefined();
    expect(calls[1]?.item.changeFiles).toContainEqual({ path: `${CHANGE}/design.md`, content: DESIGN_MD });

    const attempts = await listAttempts(f.db.pool, workItem.id);
    expect(attempts.filter((attempt) => attempt.role !== "proposal-author")).toEqual([
      expect.objectContaining({ state: "design", role: "architect", n: 1, outcome: "succeeded", result: DESIGN_RESULT }),
      expect.objectContaining({ state: "design-review", role: "design-reviewer", n: 1, outcome: "succeeded", result: { verdict: "approve", findings: [] } }),
    ]);

    // The accepted design is one commit by the bot, pushed to the branch.
    const head = remoteHead(f);
    expect(head).not.toBe(before);
    expect(changedFiles(f, head)).toEqual([`${CHANGE}/design.md`]);
    expect(identityOf(f, head)).toBe(`${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`);
  });

  it("Scenario: Large design waits for the owner", async () => {
    const workItem = await approvedWorkItem("large");
    const { ctx, calls } = designContext([architectStep()]);

    const transition = await design(ctx, workItem);

    expect(calls.map((call) => call.role)).toEqual(["architect"]);
    expect(transition).toMatchObject({ kind: "advance", route: "owner-review", workItem: { state: "awaiting-design-approval" } });
    expect(changedFiles(f, remoteHead(f))).toEqual([`${CHANGE}/design.md`]);
    if (transition.kind !== "advance") throw new Error("design did not advance");

    // AwaitApproval for the design: the open approval, then the summary with the instruction.
    const comments = f.forge.comments.length;
    await awaitApproval({ db: f.db.pool, forge: f.forge }, transition.workItem, TOKEN, "design");

    expect(await findOpenApproval(f.db.pool, workItem.id)).toMatchObject({ kind: "design", taskToken: TOKEN, state: "open" });
    expect(f.forge.comments).toHaveLength(comments + 1);
    const body = f.forge.comments.at(-1)?.body ?? "";
    expect(body).toContain(DESIGN_RESULT.summary);
    expect(body).toContain("app/contracts/src/lookup.ts");
    expect(body).toContain("0013: node:sqlite for reading vocab.db");
    // One architect attempt at the fake's $0.25.
    expect(body).toContain("$0.25");
    expect(body.trim().split("\n\n").at(-1)).toBe(DESIGN_APPROVAL_INSTRUCTION);
    expect(DESIGN_APPROVAL_INSTRUCTION).toContain("`/approve`");
    expect((await findWorkItemByIssue(f.db.pool, ISSUE.number))?.state).toBe("awaiting-design-approval");
  });

  it("Scenario: Requested changes reach the architect", async () => {
    const workItem = await approvedWorkItem("medium");
    const { ctx, calls } = designContext([architectStep(), changesRequested(BLOCKER), architectStep(DESIGN_MD_2), APPROVE]);

    const transition = await design(ctx, workItem);

    expect(transition).toMatchObject({ kind: "advance", route: "plan", workItem: { state: "plan" } });
    expect(calls.map((call) => call.role)).toEqual(["architect", "design-reviewer", "architect", "design-reviewer"]);

    // The architect's second attempt has the blocker in its prompt.
    const evidence = calls[2]?.evidence;
    expect(evidence?.reason).toBe("changes-requested");
    expect(evidence?.evidence).toContain(BLOCKER);
    expect(evidence?.evidence).toContain("design.md#Overview");
    const item = calls[2]?.item;
    if (item === undefined || evidence === undefined) throw new Error("no second architect attempt");
    expect(renderPrompt({ ...item, evidence })).toContain(BLOCKER);

    // The reviewer runs again, on the new design, with no evidence of its own.
    expect(calls[3]?.evidence).toBeUndefined();
    expect(calls[3]?.item.changeFiles).toContainEqual({ path: `${CHANGE}/design.md`, content: DESIGN_MD_2 });
    expect(designOnBranch()).toBe(DESIGN_MD_2.trimEnd());
  });

  it("Scenario: Three rejected designs escalate", async () => {
    const workItem = await approvedWorkItem("medium");
    const findings = ["First blocker: no merge rule.", "Second blocker: no book mapping.", "Third blocker: contracts missing."];
    const { ctx, calls } = designContext(findings.flatMap((summary) => [architectStep(), changesRequested(summary)]));
    const comments = f.forge.comments.length;

    const transition = await design(ctx, workItem);

    const stored = await findWorkItemByIssue(f.db.pool, ISSUE.number);
    expect(stored?.state).toBe("escalated");
    expect(transition).toEqual({ kind: "escalate", workItem: stored, reason: expect.stringContaining("design") as unknown });
    expect(MAX_DESIGN_ATTEMPTS).toBe(3);
    expect(calls.map((call) => call.role)).toEqual(["architect", "design-reviewer", "architect", "design-reviewer", "architect", "design-reviewer"]);

    // One comment, with the last findings and not the earlier ones.
    expect(f.forge.comments).toHaveLength(comments + 1);
    const body = f.forge.comments.at(-1)?.body ?? "";
    expect(body).toContain("Third blocker: contracts missing.");
    expect(body).not.toContain("First blocker");
  });

  it("retries an architect attempt that fails, with its evidence, within the three", async () => {
    const workItem = await approvedWorkItem("large");
    // A requirement without a scenario fails strict validation, as a broken change would.
    const broken: FakeStep = { files: { "design.md": DESIGN_MD, "specs/vocab-import/spec.md": "## ADDED Requirements\n\n### Requirement: Broken\nThe importer SHALL break.\n" } };
    const repaired: FakeStep = { ...architectStep(), files: { "design.md": DESIGN_MD, "specs/vocab-import/spec.md": SPEC } };
    const { ctx, calls } = designContext([broken, repaired]);

    const transition = await design(ctx, workItem);

    expect(transition).toMatchObject({ kind: "advance", route: "owner-review" });
    expect(calls[1]?.evidence?.reason).toBe("invalid-change");
    const attempts = (await listAttempts(f.db.pool, workItem.id)).filter((attempt) => attempt.role === "architect");
    expect(attempts.map((attempt) => [attempt.n, attempt.outcome, attempt.failureReason])).toEqual([
      [1, "failed", "invalid-change"],
      [2, "succeeded", null],
    ]);
  });

  it("does nothing for a work item past Design", async () => {
    const workItem = await approvedWorkItem("medium");
    await design(designContext([architectStep(), APPROVE]).ctx, workItem);
    const head = remoteHead(f);
    const { ctx, calls } = designContext([]);

    const transition = await design(ctx, (await findWorkItemByIssue(f.db.pool, ISSUE.number)) as WorkItemRow);

    expect(transition).toMatchObject({ kind: "advance", workItem: { state: "plan" } });
    expect(calls).toEqual([]);
    expect(remoteHead(f)).toBe(head);
  });
});

function designOnBranch(): string {
  return git(f.remote, "show", `${remoteHead(f)}:${CHANGE}/design.md`);
}
