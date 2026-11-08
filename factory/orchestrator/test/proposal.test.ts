import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalResult } from "@vocab/factory-artifacts";
import { FakeForge } from "@vocab/factory-forge/testing";
import { findWorkItemByIssue, LedgerRecorder, listAttempts, migrate, type WorkItemRow } from "@vocab/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@vocab/factory-ledger/testing";
import { loadRole, renderPrompt, type Role } from "@vocab/factory-roles";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { worktreePath } from "../src/git.ts";
import { intake } from "../src/intake.ts";
import { MAX_PROPOSAL_ATTEMPTS, proposal, type ProposalContext } from "../src/proposal.ts";
import { CHANGE_FILES, createFakeRoleRunner, validResult, type FakeStep } from "./fake-role-runner.ts";

const CHANGE_ID = "add-import-kindle-vocab-db";
const CHANGE = `openspec/changes/${CHANGE_ID}`;
const ISSUE = { number: 12, title: "Import Kindle vocab.db", body: "Import the lookups from the Kindle's vocab.db." };

const NO_DELTA = "Change must have at least one delta";
const NO_SCENARIO = 'ADDED "Lookups are imported" must include at least one scenario';

/** A change that passes strict validation. */
const VALID: FakeStep = {
  files: { "proposal.md": CHANGE_FILES.proposal, ".openspec.yaml": CHANGE_FILES.metadata, "specs/vocab-import/spec.md": CHANGE_FILES.spec },
};
/** A proposal without any delta spec. */
const NO_DELTA_STEP: FakeStep = { files: { "proposal.md": CHANGE_FILES.proposal } };
/** A delta spec whose requirement has no scenario. */
const NO_SCENARIO_STEP: FakeStep = { files: { "proposal.md": CHANGE_FILES.proposal, "specs/vocab-import/spec.md": CHANGE_FILES.specWithoutScenario } };

let db: TestDatabase;
let role: Role;
let root: string;
let remote: string;
let repo: string;
let home: string;
let forge: FakeForge;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, file: string, content: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
}

const remoteHead = (branch: string) => git(remote, "rev-parse", `refs/heads/${branch}`);

/** Intake for issue 12, so the work item and its branch exist as Proposal finds them. */
async function workItemInProposal(): Promise<WorkItemRow> {
  const transition = await intake({ db: db.pool, forge }, { issueNumber: ISSUE.number });
  if (transition.kind !== "advance") throw new Error(`intake did not advance: ${JSON.stringify(transition)}`);
  return transition.workItem;
}

function context(steps: FakeStep[]): { ctx: ProposalContext; calls: ReturnType<typeof createFakeRoleRunner>["calls"] } {
  const fake = createFakeRoleRunner(new LedgerRecorder(db.pool), steps);
  return { ctx: { db: db.pool, forge, runRole: fake.runRole, role, repo, home }, calls: fake.calls };
}

/** The issues of an `openspec validate --json` report. */
function validationMessages(evidence: string): string[] {
  const report = JSON.parse(evidence) as { items: { valid: boolean; issues: { message: string }[] }[] };
  return report.items.flatMap((item) => item.issues.map((issue) => issue.message));
}

beforeAll(async () => {
  db = await createTestDatabase("proposal");
  await migrate(db.pool);
  role = await loadRole("proposal-author");
  return () => db.close();
});

beforeEach(() => {
  // Keep the owner's and the system's git config (signing, hooks, identity) out of the tests.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  root = realpathSync(mkdtempSync(join(tmpdir(), "factory-proposal-")));
  remote = join(root, "remote.git");
  repo = join(root, "repo");
  home = join(root, "factory-home");

  git(root, "init", "--bare", "-b", "master", remote);
  const seed = join(root, "seed");
  git(root, "clone", remote, seed);
  write(seed, "README.md", "# vocab\n");
  write(seed, "openspec/config.yaml", "schema: spec-driven\n");
  write(seed, "openspec/specs/vocab-import/spec.md", "# vocab-import\n\n## Purpose\nImporting Kindle lookups.\n\n## Requirements\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "initial");
  git(seed, "push", "origin", "master");
  git(root, "clone", remote, repo);

  forge = new FakeForge({ remote, issues: [ISSUE] });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals");
});

describe("proposal", () => {
  it("Scenario: Valid proposal is committed and pushed", async () => {
    const workItem = await workItemInProposal();
    const branchHead = remoteHead(CHANGE_ID);
    const { ctx, calls } = context([VALID]);

    const transition = await proposal(ctx, workItem);

    const stored = await findWorkItemByIssue(db.pool, ISSUE.number);
    expect(stored?.state).toBe("awaiting-proposal-approval");
    expect(transition).toEqual({ kind: "advance", workItem: stored, result: validResult(CHANGE_ID) });

    // One attempt, run in the work item's worktree on the scaffolded change.
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.role).toBe("proposal-author");
    expect(call?.evidence).toBeUndefined();
    expect(call?.item).toMatchObject({
      id: workItem.id,
      changeId: CHANGE_ID,
      worktree: worktreePath(CHANGE_ID, home),
      issue: { title: ISSUE.title, body: ISSUE.body },
    });
    // `openspec new change` scaffolded the folder before the role ran.
    expect(call?.item.changeFiles).toEqual([
      { path: `${CHANGE}/.openspec.yaml`, content: expect.stringContaining("schema: spec-driven") as unknown },
    ]);
    expect(call?.item.specs).toEqual([{ path: "openspec/specs/vocab-import/spec.md", content: expect.stringContaining("## Purpose") as unknown }]);

    // One new commit on the branch, holding the change folder and nothing else.
    const head = remoteHead(CHANGE_ID);
    expect(git(remote, "rev-parse", `${head}^`)).toBe(branchHead);
    expect(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", head).split("\n").sort()).toEqual([
      `${CHANGE}/.openspec.yaml`,
      `${CHANGE}/proposal.md`,
      `${CHANGE}/specs/vocab-import/spec.md`,
    ]);
    expect(git(remote, "show", `${head}:${CHANGE}/proposal.md`)).toBe(CHANGE_FILES.proposal.trimEnd());

    const attempts = await listAttempts(db.pool, workItem.id);
    expect(attempts).toEqual([
      expect.objectContaining({ state: "proposal", role: "proposal-author", n: 1, outcome: "succeeded", failureReason: null, authMode: "subscription" }),
    ]);
    expect(forge.comments).toEqual([]);
  });

  it("Scenario: Invalid proposal is retried with evidence", async () => {
    const workItem = await workItemInProposal();
    const { ctx, calls } = context([NO_DELTA_STEP, VALID]);

    const transition = await proposal(ctx, workItem);

    expect(transition).toMatchObject({ kind: "advance", workItem: { state: "awaiting-proposal-approval" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.evidence).toBeUndefined();

    // The second attempt gets the first one's `openspec validate --json` report, and sees its files.
    const evidence = calls[1]?.evidence;
    expect(evidence?.reason).toBe("invalid-change");
    expect(validationMessages(evidence?.evidence ?? "{}")).toEqual([expect.stringContaining(NO_DELTA)]);
    expect(calls[1]?.item.changeFiles.map((file) => file.path)).toContain(`${CHANGE}/proposal.md`);
    const item = calls[1]?.item;
    if (item === undefined || evidence === undefined) throw new Error("no second attempt");
    expect(renderPrompt({ ...item, evidence })).toContain(NO_DELTA);

    const attempts = await listAttempts(db.pool, workItem.id);
    expect(attempts).toEqual([
      expect.objectContaining({ n: 1, outcome: "failed", failureReason: "invalid-change", authMode: "subscription" }),
      expect.objectContaining({ n: 2, outcome: "succeeded", failureReason: null, authMode: "subscription" }),
    ]);
    expect(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", remoteHead(CHANGE_ID))).toContain(`${CHANGE}/specs/vocab-import/spec.md`);
  });

  it("Scenario: Proposal result is stored in the ledger", async () => {
    const workItem = await workItemInProposal();
    const { ctx } = context([NO_DELTA_STEP, VALID]);

    await proposal(ctx, workItem);

    // The succeeded attempt holds the role's validated result; the failed one holds none.
    const attempts = await listAttempts(db.pool, workItem.id);
    expect(attempts.map((attempt) => [attempt.outcome, attempt.result])).toEqual([
      ["failed", null],
      ["succeeded", validResult(CHANGE_ID)],
    ]);
    expect(ProposalResult.safeParse(attempts[1]?.result).success).toBe(true);
  });

  it("Scenario: Three failed attempts escalate", async () => {
    const workItem = await workItemInProposal();
    const branchHead = remoteHead(CHANGE_ID);
    const { ctx, calls } = context([NO_DELTA_STEP, NO_DELTA_STEP, NO_SCENARIO_STEP]);

    const transition = await proposal(ctx, workItem);

    const stored = await findWorkItemByIssue(db.pool, ISSUE.number);
    expect(stored?.state).toBe("escalated");
    // The CLI turns an `escalate` into a non-zero exit (task 7.2).
    expect(transition).toEqual({ kind: "escalate", workItem: stored, reason: expect.stringContaining("invalid-change") as unknown });

    expect(MAX_PROPOSAL_ATTEMPTS).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.evidence?.reason)).toEqual([undefined, "invalid-change", "invalid-change"]);

    const attempts = await listAttempts(db.pool, workItem.id);
    expect(attempts.map((attempt) => [attempt.n, attempt.outcome, attempt.failureReason, attempt.authMode])).toEqual([
      [1, "failed", "invalid-change", "subscription"],
      [2, "failed", "invalid-change", "subscription"],
      [3, "failed", "invalid-change", "subscription"],
    ]);

    // One comment, with the last attempt's validation errors, not the earlier ones.
    expect(forge.comments).toHaveLength(1);
    expect(forge.comments[0]?.issueNumber).toBe(ISSUE.number);
    expect(forge.comments[0]?.body).toContain(NO_SCENARIO);
    expect(forge.comments[0]?.body).not.toContain(NO_DELTA);

    // Nothing was pushed.
    expect(remoteHead(CHANGE_ID)).toBe(branchHead);
  });

  it("escalates an auth-mode-mismatch at once, without a retry", async () => {
    const workItem = await workItemInProposal();
    const branchHead = remoteHead(CHANGE_ID);
    const { ctx, calls } = context([{ ...VALID, apiKeySource: "ANTHROPIC_API_KEY" }, VALID]);

    const transition = await proposal(ctx, workItem);

    const stored = await findWorkItemByIssue(db.pool, ISSUE.number);
    expect(stored?.state).toBe("escalated");
    expect(transition).toEqual({ kind: "escalate", workItem: stored, reason: expect.stringContaining("auth-mode-mismatch") as unknown });
    expect(calls).toHaveLength(1);

    // The ledger keeps the mode the session reported, not the configured one.
    const attempts = await listAttempts(db.pool, workItem.id);
    expect(attempts).toEqual([expect.objectContaining({ n: 1, outcome: "failed", failureReason: "auth-mode-mismatch", authMode: "api-key" })]);

    expect(forge.comments).toHaveLength(1);
    expect(forge.comments[0]?.body).toContain("auth-mode-mismatch");
    expect(remoteHead(CHANGE_ID)).toBe(branchHead);
  });
});

describe("proposal-author budget", () => {
  it("Scenario: Three attempts stay within the work-item limit", async () => {
    const role = await loadRole("proposal-author");
    expect(role.maxBudgetUsd * MAX_PROPOSAL_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});
