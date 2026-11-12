import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "@vocab/factory-forge/testing";
import { findWorkItemByIssue, LedgerRecorder, listAttempts, migrate, setWorkItemState } from "@vocab/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@vocab/factory-ledger/testing";
import { loadRole, type PlanPaths, type Role } from "@vocab/factory-roles";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeBuildRunner, type FakeBuildCall, type FakeBuildStep } from "../../orchestrator/test/fake-build-runner.ts";
import { CHANGE_FILES, createFakeRoleRunner, validResult, type FakeCall, type FakeStep } from "../../orchestrator/test/fake-role-runner.ts";
import { FsStore } from "../../worker/src/store.ts";
import { EXIT_CODES, runCli, type CliEnv } from "../src/cli.ts";

const CHANGE_ID = "add-import-kindle-vocab-db";
const ISSUE = { number: 12, title: "Import Kindle vocab.db", body: "Import the lookups from the Kindle's vocab.db." };
const RUN = ["run", "--issue", String(ISSUE.number), "--until", "proposal"];
const COST = ["cost", "--issue", String(ISSUE.number)];
const OPEN_QUESTION = "Should a re-import skip lookups already imported?";

/** A change that passes strict validation. */
const VALID: FakeStep = {
  files: { "proposal.md": CHANGE_FILES.proposal, ".openspec.yaml": CHANGE_FILES.metadata, "specs/vocab-import/spec.md": CHANGE_FILES.spec },
  result: { ...validResult(CHANGE_ID), complexity: "medium", openQuestions: [OPEN_QUESTION] },
};
/** A proposal without any delta spec, which strict validation rejects. */
const INVALID: FakeStep = { files: { "proposal.md": CHANGE_FILES.proposal } };

/** The same valid change as `medium`: Approved routes on `.openspec.yaml`. */
const MEDIUM: FakeStep = { ...VALID, files: { ...VALID.files, ".openspec.yaml": CHANGE_FILES.metadata.replace("small", "medium") } };
const APPROVE = ["approve", "--issue", String(ISSUE.number)];
const until = (stop: string) => ["run", "--issue", String(ISSUE.number), "--until", stop];

/** Two tasks; the change's one scenario is task 1.1's. */
const TASKS_MD = ["# Tasks", "", "## 1. Import", "", "- [ ] 1.1 Parse the lookups", "- [ ] 1.2 Count the lookups", ""].join("\n");
const PLAN = {
  tasks: [
    { id: "1.1", title: "Parse the lookups", dependsOn: [], files: ["app/domain/src/lookups.ts"], scenarios: ["Lookups are imported"], tests: ["app/domain/test/lookups.test.ts"] },
    { id: "1.2", title: "Count the lookups", dependsOn: ["1.1"], files: ["app/domain/src/counts.ts"], scenarios: [], tests: ["app/domain/test/counts.test.ts"] },
  ],
};
const PLANNER: FakeStep = { files: { "tasks.md": TASKS_MD }, result: PLAN };
const ARCHITECT: FakeStep = { files: { "design.md": "# Design\n\n## Overview\n\nRead vocab.db with node:sqlite.\n" }, result: { summary: "Read vocab.db.", contracts: [], adrNeeded: [], openQuestions: [] } };
const REVIEW_APPROVES: FakeStep = { result: { verdict: "approve", findings: [] } };
const files = (entries: Record<string, string>): FakeBuildStep => ({ files: entries });
const BUILDS: FakeBuildStep[] = [
  files({ "app/domain/test/lookups.test.ts": 'it("Scenario: Lookups are imported", () => {});\n', "app/domain/src/lookups.ts": "export {};\n" }),
  files({ "app/domain/src/lookups.ts": "export const lookups = [];\n" }),
  files({ "app/domain/test/counts.test.ts": 'it("counts", () => {});\n', "app/domain/src/counts.ts": "export {};\n" }),
  files({ "app/domain/src/counts.ts": "export const counts = 0;\n" }),
];

let db: TestDatabase;
let role: Role;
let roles: { architect: Role; designReviewer: Role; planner: Role; planPaths: PlanPaths; testAuthor: Role; implementer: Role; classifier: Role };
let storeDir: string;
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

interface Cli {
  /** Runs one command with the scripted role-runner and build steps; resolves with its exit code and output. */
  run(argv: string[], steps?: FakeStep[], builds?: FakeBuildStep[]): Promise<{ code: number; out: string; err: string }>;
  /** Every role-runner call, across all commands. */
  calls: FakeCall[];
  /** Every build, across all commands. */
  builds: FakeBuildCall[];
}

/** The CLI on the test ledger, the FakeForge, a scripted fake role runner and a fake build runner on an FsStore. */
function cli(): Cli {
  const calls: FakeCall[] = [];
  const builds: FakeBuildCall[] = [];
  return {
    calls,
    builds,
    async run(argv, steps = [], buildSteps = []) {
      let out = "";
      let err = "";
      const fake = createFakeRoleRunner(new LedgerRecorder(db.pool), steps);
      const store = new FsStore(storeDir);
      const build = createFakeBuildRunner(store, buildSteps);
      const env: CliEnv = {
        db: db.pool,
        out: (text) => (out += text),
        err: (text) => (err += text),
        runContext: () =>
          Promise.resolve({ forge, runRole: fake.runRole, role, repo, home, ...roles, store, runBuild: build.runBuild, cloneUrl: remote, wait: () => Promise.resolve() }),
      };
      const code = await runCli(argv, env);
      calls.push(...fake.calls);
      builds.push(...build.calls);
      return { code, out, err };
    },
  };
}

async function attemptCount(): Promise<number> {
  const workItem = await findWorkItemByIssue(db.pool, ISSUE.number);
  return workItem === undefined ? 0 : (await listAttempts(db.pool, workItem.id)).length;
}

beforeAll(async () => {
  db = await createTestDatabase("cli_run");
  await migrate(db.pool);
  role = await loadRole("proposal-author");
  const [architect, designReviewer, planner, testAuthor, implementer, classifier] = await Promise.all(
    ["architect", "design-reviewer", "planner", "test-author", "implementer", "failure-classifier"].map((name) => loadRole(name)),
  );
  if (architect === undefined || designReviewer === undefined || planner === undefined || testAuthor === undefined || implementer === undefined || classifier === undefined) {
    throw new Error("missing role");
  }
  roles = { architect, designReviewer, planner, planPaths: { implementer: implementer.writable, testAuthor: testAuthor.writable }, testAuthor, implementer, classifier };
  return () => db.close();
});

beforeEach(() => {
  // Keep the owner's and the system's git config (signing, hooks, identity) out of the tests.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  root = realpathSync(mkdtempSync(join(tmpdir(), "factory-cli-")));
  remote = join(root, "remote.git");
  repo = join(root, "repo");
  home = join(root, "factory-home");
  storeDir = join(root, "store");

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
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks");
});

describe("factory run", () => {
  it("Scenario: Summary comment is posted", async () => {
    const factory = cli();

    const { code, out } = await factory.run(RUN, [VALID]);

    expect(code).toBe(EXIT_CODES.ok);
    const workItem = await findWorkItemByIssue(db.pool, ISSUE.number);
    expect(workItem?.state).toBe("awaiting-proposal-approval");
    expect(out).toContain("awaiting-proposal-approval");
    expect(factory.calls).toHaveLength(1);

    expect(forge.comments).toHaveLength(1);
    const [comment] = forge.comments;
    expect(comment?.issueNumber).toBe(ISSUE.number);
    const body = comment?.body ?? "";
    expect(body).toContain(CHANGE_ID);
    expect(body).toContain("vocab-import");
    expect(body).toMatch(/complexity\W+medium/i);
    expect(body).toMatch(/open questions/i);
    expect(body).toContain(OPEN_QUESTION);
    // Why and what changes, from the pushed proposal.md.
    expect(body).toContain("Owners want their Kindle lookups in the app.");
    expect(body).toContain("Import the lookups from a Kindle vocab.db.");
  });

  it("Scenario: Re-run after completion does nothing", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const head = git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`);
    const attempts = await attemptCount();
    const comments = forge.comments.length;

    // No scripted steps: any agent run would fail the fake.
    const { code, out } = await factory.run(RUN);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls).toHaveLength(1);
    expect(await attemptCount()).toBe(attempts);
    expect(forge.comments).toHaveLength(comments);
    expect(git(remote, "rev-parse", `refs/heads/${CHANGE_ID}`)).toBe(head);
    expect(out).toContain("awaiting-proposal-approval");
    const { rows } = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM work_items WHERE issue_number = $1", [ISSUE.number]);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("treats a proposal-approved work item as past --until proposal", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const workItem = await findWorkItemByIssue(db.pool, ISSUE.number);
    await setWorkItemState(db.pool, workItem?.id ?? "", "proposal-approved");
    const comments = forge.comments.length;

    // No scripted steps: any agent run would fail the fake.
    const { code, out } = await factory.run(RUN);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls).toHaveLength(1);
    expect(forge.comments).toHaveLength(comments);
    expect(out).toContain("proposal-approved");
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal-approved");
  });

  it("re-running an escalated work item runs no agent and exits non-zero", async () => {
    const factory = cli();
    const first = await factory.run(RUN, [INVALID, INVALID, INVALID]);
    expect(first.code).toBe(EXIT_CODES.failed);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("escalated");
    const attempts = await attemptCount();
    const comments = forge.comments.length;

    const { code, out, err } = await factory.run(RUN);

    expect(code).toBe(EXIT_CODES.failed);
    expect(factory.calls).toHaveLength(3);
    expect(await attemptCount()).toBe(attempts);
    expect(forge.comments).toHaveLength(comments);
    expect(out + err).toContain("escalated");
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("escalated");
  });
});

describe("factory run, after Proposal", { timeout: 60_000 }, () => {
  it("Scenario: Local run reaches the pull request", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    const approval = await factory.run(APPROVE);
    expect(approval.code).toBe(EXIT_CODES.ok);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal-approved");

    const { code, out } = await factory.run(until("pr"), [PLANNER], BUILDS);

    expect(code).toBe(EXIT_CODES.ok);
    // The plan's tasks are built in order, tests first.
    expect(factory.builds.map((call) => [call.taskId, call.next.role])).toEqual([
      ["1.1", "test-author"],
      ["1.1", "implementer"],
      ["1.2", "test-author"],
      ["1.2", "implementer"],
    ]);
    // Each is ticked in tasks.md on the branch.
    const tasksMd = git(remote, "show", `refs/heads/${CHANGE_ID}:openspec/changes/${CHANGE_ID}/tasks.md`);
    expect(tasksMd).toContain("- [x] 1.1 Parse the lookups");
    expect(tasksMd).toContain("- [x] 1.2 Count the lookups");
    // A pull request is open from the change branch, and the work item is pr-open.
    expect(forge.pullRequests).toEqual([expect.objectContaining({ head: CHANGE_ID, base: "master" })]);
    const workItem = await findWorkItemByIssue(db.pool, ISSUE.number);
    expect(workItem?.state).toBe("pr-open");
    expect(out).toContain("pr-open");
    expect(out).toContain(forge.pullRequests[0]?.url ?? "no url");
  });

  it("stops with --until design once the design is accepted", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [MEDIUM])).code).toBe(EXIT_CODES.ok);
    expect((await factory.run(APPROVE)).code).toBe(EXIT_CODES.ok);

    const { code, out } = await factory.run(until("design"), [ARCHITECT, REVIEW_APPROVES]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author", "architect", "design-reviewer"]);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("plan");
    expect(out).toContain("plan");
    expect(factory.builds).toEqual([]);
  });

  it("stops with --until plan once the plan is stored", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    expect((await factory.run(APPROVE)).code).toBe(EXIT_CODES.ok);

    const { code, out } = await factory.run(until("plan"), [PLANNER]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author", "planner"]);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("build");
    expect(out).toContain("build");
    expect(factory.builds).toEqual([]);
    expect(forge.pullRequests).toEqual([]);
  });

  it("stops at an open approval and names the approve command", async () => {
    const factory = cli();

    const { code, out } = await factory.run(until("pr"), [VALID]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author"]);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("awaiting-proposal-approval");
    expect(out).toContain(`pnpm factory approve --issue ${String(ISSUE.number)}`);
  });

  it("stops at a large change's design approval, which approve closes", async () => {
    const factory = cli();
    const large: FakeStep = { ...VALID, files: { ...VALID.files, ".openspec.yaml": CHANGE_FILES.metadata.replace("small", "large") } };
    expect((await factory.run(RUN, [large])).code).toBe(EXIT_CODES.ok);
    expect((await factory.run(APPROVE)).code).toBe(EXIT_CODES.ok);

    const stopped = await factory.run(until("pr"), [ARCHITECT]);
    expect(stopped.code).toBe(EXIT_CODES.ok);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("awaiting-design-approval");
    expect(stopped.out).toContain(`pnpm factory approve --issue ${String(ISSUE.number)}`);

    const approval = await factory.run(APPROVE);
    expect(approval.code).toBe(EXIT_CODES.ok);
    expect(approval.out).toMatch(/design/i);
    const { code } = await factory.run(until("plan"), [PLANNER]);
    expect(code).toBe(EXIT_CODES.ok);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("build");
    expect(factory.calls.map((call) => call.role)).toEqual(["proposal-author", "architect", "planner"]);
  });

  it("answers approve with nothing awaiting, changing nothing", async () => {
    const factory = cli();
    expect((await factory.run(RUN, [VALID])).code).toBe(EXIT_CODES.ok);
    expect((await factory.run(APPROVE)).code).toBe(EXIT_CODES.ok);
    const comments = forge.comments.length;

    const { code, err } = await factory.run(APPROVE);

    expect(code).toBe(EXIT_CODES.failed);
    expect(err).toMatch(/nothing awaits approval/i);
    expect(err).toContain("proposal-approved");
    expect(forge.comments).toHaveLength(comments);
    expect((await findWorkItemByIssue(db.pool, ISSUE.number))?.state).toBe("proposal-approved");
  });
});

describe("factory cost", () => {
  it("Scenario: Cost is visible after a run", async () => {
    const factory = cli();
    // Each fake attempt records 1,000 input and 500 output tokens.
    expect((await factory.run(RUN, [{ ...INVALID, costUsd: 0.25 }, { ...VALID, costUsd: 0.5 }])).code).toBe(EXIT_CODES.ok);

    const { code, out } = await factory.run(COST);

    expect(code).toBe(EXIT_CODES.ok);
    const lines = out.split("\n");
    const attempt = (n: number) => lines.find((line) => new RegExp(`^\\s*#${String(n)}\\b`).test(line)) ?? "";
    expect(attempt(1)).toMatch(/proposal-author/);
    expect(attempt(1)).toMatch(/failed.*invalid-change/);
    expect(attempt(1)).toMatch(/subscription/);
    expect(attempt(1)).toMatch(/1,500 tokens/);
    expect(attempt(1)).toMatch(/\$0\.25\b/);
    expect(attempt(2)).toMatch(/succeeded/);
    expect(attempt(2)).toMatch(/subscription/);
    expect(attempt(2)).toMatch(/1,500 tokens/);
    expect(attempt(2)).toMatch(/\$0\.50\b/);
    expect(lines.find((line) => /total/i.test(line))).toMatch(/3,000 tokens.*\$0\.75\b/);
    expect(out).toContain(CHANGE_ID);
  });
});
