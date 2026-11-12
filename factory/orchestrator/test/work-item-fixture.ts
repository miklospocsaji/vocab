/**
 * Test helper for the handlers after Proposal: a temp bare remote with the repository's
 * openspec layout, a local clone, a FakeForge on that remote, the real local ledger, and a work
 * item whose valid proposal (with the given `x-complexity`) is pushed to its branch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "@vocab/factory-forge/testing";
import { LedgerRecorder, migrate, type WorkItemRow } from "@vocab/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@vocab/factory-ledger/testing";
import { loadRole, type PlanPaths } from "@vocab/factory-roles";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { approved } from "../src/approval.ts";
import { changeFileReader, type GitIdentity } from "../src/git.ts";
import { intake } from "../src/intake.ts";
import { plan } from "../src/plan.ts";
import { proposal } from "../src/proposal.ts";
import { CHANGE_FILES, createFakeRoleRunner, validResult, type FakeStep } from "./fake-role-runner.ts";

export const CHANGE_ID = "add-import-kindle-vocab-db";
export const CHANGE = `openspec/changes/${CHANGE_ID}`;
export const ISSUE = { number: 12, title: "Import Kindle vocab.db", body: "Import the lookups and books from the Kindle's vocab.db." };

/** The App's bot user, as the worker commits as it. */
export const BOT: GitIdentity = { name: "vocab-factory[bot]", email: "123456+vocab-factory[bot]@users.noreply.github.com" };

/** A delta spec with two scenarios, so a plan can split them over two tasks. */
export const SPEC = [
  "## ADDED Requirements",
  "",
  "### Requirement: Lookups are imported",
  "The importer SHALL import every lookup in a Kindle vocab.db.",
  "",
  "#### Scenario: Lookups are imported",
  "- **WHEN** the owner uploads a vocab.db",
  "- **THEN** every lookup in it is stored",
  "",
  "### Requirement: Books are imported",
  "The importer SHALL import the book of every lookup.",
  "",
  "#### Scenario: Books are imported",
  "- **WHEN** the owner uploads a vocab.db",
  "- **THEN** every book with a lookup is stored",
  "",
].join("\n");

export const metadata = (complexity: string): string => `schema: spec-driven\ncreated: 2026-11-01\nx-complexity: ${complexity}\n`;

export interface Fixture {
  db: TestDatabase;
  forge: FakeForge;
  root: string;
  remote: string;
  repo: string;
  home: string;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, file: string, content: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
}

/** Registers the hooks; the returned object's fields are set once `beforeEach` has run. */
export function useWorkItemFixture(label: string): Fixture {
  const f = {} as Fixture;

  beforeAll(async () => {
    f.db = await createTestDatabase(label);
    await migrate(f.db.pool);
    return () => f.db.close();
  });

  beforeEach(() => {
    // Keep the owner's and the system's git config (signing, hooks, identity) out of the tests.
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

    f.root = realpathSync(mkdtempSync(join(tmpdir(), `factory-${label}-`)));
    f.remote = join(f.root, "remote.git");
    f.repo = join(f.root, "repo");
    f.home = join(f.root, "factory-home");

    git(f.root, "init", "--bare", "-b", "master", f.remote);
    const seed = join(f.root, "seed");
    git(f.root, "clone", f.remote, seed);
    write(seed, "README.md", "# vocab\n");
    write(seed, "openspec/config.yaml", "schema: spec-driven\n");
    write(seed, "openspec/specs/vocab-import/spec.md", "# vocab-import\n\n## Purpose\nImporting Kindle lookups.\n\n## Requirements\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "initial");
    git(seed, "push", "origin", "master");
    git(f.root, "clone", f.remote, f.repo);

    f.forge = new FakeForge({ remote: f.remote, issues: [ISSUE] });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync(f.root, { recursive: true, force: true });
    await f.db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks");
  });

  return f;
}

/** The proposal author's step for a valid change of the given complexity. */
export function proposalStep(complexity: string): FakeStep {
  return {
    files: { "proposal.md": CHANGE_FILES.proposal, ".openspec.yaml": metadata(complexity), "specs/vocab-import/spec.md": SPEC },
    result: { ...validResult(CHANGE_ID), complexity: ["small", "medium", "large"].includes(complexity) ? complexity : "small" },
  };
}

/** Intake and a valid proposal of the given complexity: the work item is awaiting-proposal-approval. */
export async function proposedWorkItem(f: Fixture, complexity: string): Promise<WorkItemRow> {
  const ctx = { db: f.db.pool, forge: f.forge };
  const created = await intake(ctx, { issueNumber: ISSUE.number });
  if (created.kind !== "advance") throw new Error(`intake did not advance: ${JSON.stringify(created)}`);
  const fake = createFakeRoleRunner(new LedgerRecorder(f.db.pool), [proposalStep(complexity)]);
  const proposed = await proposal(
    { ...ctx, runRole: fake.runRole, role: await loadRole("proposal-author"), repo: f.repo, home: f.home, committer: BOT },
    created.workItem,
  );
  if (proposed.kind !== "advance") throw new Error(`proposal did not advance: ${JSON.stringify(proposed)}`);
  return proposed.workItem;
}

export const remoteHead = (f: Fixture, branch = CHANGE_ID): string => git(f.remote, "rev-parse", `refs/heads/${branch}`);

/** The files one commit on the remote changed. */
export const changedFiles = (f: Fixture, commit: string): string[] =>
  git(f.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter((line) => line !== "").sort();

/** `author name|author email|committer name|committer email` of a commit on the remote. */
export const identityOf = (f: Fixture, commit: string): string => git(f.remote, "log", "-1", "--format=%an|%ae|%cn|%ce", commit);

/** A two-task plan for the fixture's change, and its tasks.md. */
export const TASKS_MD = ["# Tasks", "", "## 1. Import", "", "- [ ] 1.1 Parse the lookups", "- [ ] 1.2 Parse the books", ""].join("\n");
export const PLAN = {
  tasks: [
    {
      id: "1.1",
      title: "Parse the lookups",
      dependsOn: [],
      files: ["app/domain/src/lookups.ts"],
      scenarios: ["Lookups are imported"],
      tests: ["app/domain/test/lookups.test.ts"],
    },
    {
      id: "1.2",
      title: "Parse the books",
      dependsOn: ["1.1"],
      files: ["app/domain/src/books.ts"],
      scenarios: ["Books are imported"],
      tests: ["app/domain/test/books.test.ts"],
    },
  ],
};

/** The planner's step for a plan and its tasks.md. */
export const planStep = (tasksMd = TASKS_MD, result: unknown = PLAN): FakeStep => ({ files: { "tasks.md": tasksMd }, result });

/** A `small` change through Approved and Plan: the work item is in `build`, with PLAN's tasks in the ledger. */
export async function plannedWorkItem(f: Fixture): Promise<WorkItemRow> {
  const ctx = { db: f.db.pool, forge: f.forge };
  const routed = await approved({ ...ctx, readChangeFile: changeFileReader({ repo: f.repo, home: f.home }) }, await proposedWorkItem(f, "small"));
  if (routed.kind !== "advance") throw new Error(`approved did not advance: ${JSON.stringify(routed)}`);
  const fake = createFakeRoleRunner(new LedgerRecorder(f.db.pool), [planStep()]);
  const planned = await plan(
    { ...ctx, runRole: fake.runRole, planner: await loadRole("planner"), planPaths: await planPaths(), repo: f.repo, home: f.home, committer: BOT },
    routed.workItem,
  );
  if (planned.kind !== "advance") throw new Error(`plan did not advance: ${JSON.stringify(planned)}`);
  return planned.workItem;
}

/** The plan paths from the build roles' configs. */
export async function planPaths(): Promise<PlanPaths> {
  return { implementer: (await loadRole("implementer")).writable, testAuthor: (await loadRole("test-author")).writable };
}

/** The subjects of the commits on the remote branch after `since`, oldest first. */
export const subjectsSince = (f: Fixture, since: string, branch = CHANGE_ID): string[] =>
  git(f.remote, "log", "--reverse", "--format=%s", `${since}..refs/heads/${branch}`).split("\n").filter((line) => line !== "");
