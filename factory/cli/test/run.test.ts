import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "@vocab/factory-forge/testing";
import { findWorkItemByIssue, LedgerRecorder, listAttempts, migrate } from "@vocab/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@vocab/factory-ledger/testing";
import { loadRole, type Role } from "@vocab/factory-roles";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGE_FILES, createFakeRoleRunner, validResult, type FakeCall, type FakeStep } from "../../orchestrator/test/fake-role-runner.ts";
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

interface Cli {
  /** Runs one command with the scripted role-runner steps; resolves with its exit code and output. */
  run(argv: string[], steps?: FakeStep[]): Promise<{ code: number; out: string; err: string }>;
  /** Every role-runner call, across all commands. */
  calls: FakeCall[];
}

/** The CLI on the test ledger, the FakeForge and a scripted fake role runner. */
function cli(): Cli {
  const calls: FakeCall[] = [];
  return {
    calls,
    async run(argv, steps = []) {
      let out = "";
      let err = "";
      const fake = createFakeRoleRunner(new LedgerRecorder(db.pool), steps);
      const env: CliEnv = {
        db: db.pool,
        out: (text) => (out += text),
        err: (text) => (err += text),
        runContext: () => Promise.resolve({ forge, runRole: fake.runRole, role, repo, home }),
      };
      const code = await runCli(argv, env);
      calls.push(...fake.calls);
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
