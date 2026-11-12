import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "@vocab/factory-forge/testing";
import { findWorkItemByIssue, migrate } from "@vocab/factory-ledger";
import { createTestDatabase, type TestDatabase } from "@vocab/factory-ledger/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { intake } from "../src/intake.ts";

const CHANGE_ID = "add-import-kindle-vocab-db";

let db: TestDatabase;
let root: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

/** The remote's branches, as `refs/heads/<name>` → sha. */
function remoteBranches(): Record<string, string> {
  const lines = git(remote, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/").split("\n").filter((l) => l !== "");
  return Object.fromEntries(lines.map((line) => line.split(" ") as [string, string]));
}

async function workItemCount(issueNumber: number): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM work_items WHERE issue_number = $1", [issueNumber]);
  return Number(rows[0]?.n);
}

beforeAll(async () => {
  db = await createTestDatabase("intake");
  await migrate(db.pool);
  return () => db.close();
});

beforeEach(() => {
  // Keep the owner's and the system's git config (signing, hooks, identity) out of the tests.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  root = realpathSync(mkdtempSync(join(tmpdir(), "factory-intake-")));
  remote = join(root, "remote.git");
  git(root, "init", "--bare", "-b", "master", remote);
  const seed = join(root, "seed");
  git(root, "clone", remote, seed);
  writeFileSync(join(seed, "README.md"), "# vocab\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "initial");
  git(seed, "push", "origin", "master");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  await db.pool.query("TRUNCATE work_items, attempts, messages, events, approvals, tasks");
});

describe("intake", () => {
  it("Scenario: Work item and branch are created", async () => {
    const forge = new FakeForge({
      remote,
      issues: [{ number: 12, title: "Import Kindle vocab.db", body: "Import the lookups from the Kindle's vocab.db." }],
    });
    const masterHead = git(remote, "rev-parse", "refs/heads/master");

    const transition = await intake({ db: db.pool, forge }, { issueNumber: 12 });

    const workItem = await findWorkItemByIssue(db.pool, 12);
    expect(workItem).toMatchObject({ issueNumber: 12, changeId: CHANGE_ID, branch: CHANGE_ID, state: "proposal" });
    expect(await workItemCount(12)).toBe(1);
    expect(transition).toEqual({ kind: "advance", workItem });

    expect(remoteBranches()).toEqual({ "refs/heads/master": masterHead, [`refs/heads/${CHANGE_ID}`]: masterHead });
    expect(await forge.branchExists(CHANGE_ID)).toBe(true);
    expect(forge.comments).toEqual([]);
  });

  it("Scenario: Issue without a requirement is rejected", async () => {
    const forge = new FakeForge({ remote, issues: [{ number: 13, title: "Import Kindle vocab.db", body: null }] });
    const masterHead = git(remote, "rev-parse", "refs/heads/master");

    const transition = await intake({ db: db.pool, forge }, { issueNumber: 13 });

    // The CLI turns a `reject` into a non-zero exit (task 7.2).
    expect(transition).toMatchObject({ kind: "reject", reason: expect.stringMatching(/requirement/i) as unknown });
    expect(await findWorkItemByIssue(db.pool, 13)).toBeUndefined();
    expect(await workItemCount(13)).toBe(0);

    expect(remoteBranches()).toEqual({ "refs/heads/master": masterHead });
    expect(await forge.branchExists(CHANGE_ID)).toBe(false);

    expect(forge.comments).toHaveLength(1);
    expect(forge.comments[0]).toMatchObject({ issueNumber: 13, body: expect.stringMatching(/requirement/i) as unknown });
  });
});
