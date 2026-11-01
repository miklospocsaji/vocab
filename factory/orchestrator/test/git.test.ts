import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitChange, ensureWorktree, factoryHome, push, worktreePath } from "../src/git.ts";

const CHANGE_ID = "add-sample";
const CHANGE_DIR = `openspec/changes/${CHANGE_ID}`;

let root: string;
let remote: string;
let repo: string;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

const remoteHead = (branch: string) => git(remote, "rev-parse", `refs/heads/${branch}`);

beforeEach(() => {
  // Keep the owner's and the system's git config (signing, hooks, identity) out of the tests.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  root = realpathSync(mkdtempSync(join(tmpdir(), "factory-git-")));
  remote = join(root, "remote.git");
  repo = join(root, "repo");
  home = join(root, "factory-home");

  git(root, "init", "--bare", "-b", "master", remote);
  const seed = join(root, "seed");
  git(root, "clone", remote, seed);
  write(seed, "README.md", "# vocab\n");
  write(seed, "openspec/changes/.gitkeep", "");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "initial");
  git(seed, "push", "origin", "master");
  // Intake creates the work item's branch on the remote (Forge.createBranch) before any worktree exists.
  git(seed, "push", "origin", `master:refs/heads/${CHANGE_ID}`);

  git(root, "clone", remote, repo);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("factoryHome", () => {
  it("is $FACTORY_HOME when set and ~/.factory otherwise", () => {
    expect(factoryHome({ FACTORY_HOME: "/srv/factory" })).toBe("/srv/factory");
    expect(factoryHome({})).toBe(join(homedir(), ".factory"));
    expect(factoryHome({ FACTORY_HOME: "" })).toBe(join(homedir(), ".factory"));
  });

  it("puts a work item's worktree at <home>/worktrees/<change-id>", () => {
    expect(worktreePath(CHANGE_ID, "/srv/factory")).toBe("/srv/factory/worktrees/add-sample");
  });
});

describe("ensureWorktree", () => {
  it("creates the worktree under $FACTORY_HOME/worktrees/<change-id> on the work item's branch", async () => {
    const worktree = await ensureWorktree({ repo, changeId: CHANGE_ID, branch: CHANGE_ID, home });

    expect(worktree).toBe(join(home, "worktrees", CHANGE_ID));
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(CHANGE_ID);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(remoteHead(CHANGE_ID));
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("# vocab\n");
    // The source checkout stays on its own branch, untouched.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
  });

  it("reuses the existing worktree on re-run", async () => {
    const first = await ensureWorktree({ repo, changeId: CHANGE_ID, branch: CHANGE_ID, home });
    expect(first).toBe(join(home, "worktrees", CHANGE_ID));
    write(first, `${CHANGE_DIR}/proposal.md`, "work in progress\n");

    const second = await ensureWorktree({ repo, changeId: CHANGE_ID, branch: CHANGE_ID, home });

    expect(second).toBe(first);
    expect(readFileSync(join(second, CHANGE_DIR, "proposal.md"), "utf8")).toBe("work in progress\n");
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(2);
  });
});

describe("commitChange", () => {
  it("commits only the change folder", async () => {
    const worktree = await ensureWorktree({ repo, changeId: CHANGE_ID, branch: CHANGE_ID, home });
    expect(worktree).toBe(join(home, "worktrees", CHANGE_ID));
    const parent = git(worktree, "rev-parse", "HEAD");

    write(worktree, `${CHANGE_DIR}/proposal.md`, "# Proposal\n");
    write(worktree, `${CHANGE_DIR}/specs/orchestration/spec.md`, "# Spec\n");
    write(worktree, "README.md", "# changed outside the change folder\n");
    write(worktree, "stray.txt", "untracked\n");
    write(worktree, "staged.txt", "staged\n");
    git(worktree, "add", "staged.txt");

    const sha = await commitChange({ worktree, changeId: CHANGE_ID, message: "feat: propose add-sample" });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(sha);
    expect(git(worktree, "rev-parse", `${sha}^`)).toBe(parent);
    expect(git(worktree, "log", "-1", "--format=%s", sha)).toBe("feat: propose add-sample");
    expect(git(worktree, "show", "--name-only", "--format=", sha).split("\n").sort()).toEqual([
      `${CHANGE_DIR}/proposal.md`,
      `${CHANGE_DIR}/specs/orchestration/spec.md`,
    ]);
    // Changes outside the folder are left as they were, not committed and not lost.
    expect(git(worktree, "status", "--porcelain").split("\n").sort()).toEqual(["?? stray.txt", "A  staged.txt", "M README.md"]);
  });
});

describe("push", () => {
  it("pushes the work item's branch to the remote", async () => {
    const worktree = await ensureWorktree({ repo, changeId: CHANGE_ID, branch: CHANGE_ID, home });
    expect(worktree).toBe(join(home, "worktrees", CHANGE_ID));
    write(worktree, `${CHANGE_DIR}/proposal.md`, "# Proposal\n");
    const sha = await commitChange({ worktree, changeId: CHANGE_ID, message: "feat: propose add-sample" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    await push({ worktree, branch: CHANGE_ID });

    expect(remoteHead(CHANGE_ID)).toBe(sha);
    expect(git(remote, "show", `${sha}:${CHANGE_DIR}/proposal.md`)).toBe("# Proposal");
    expect(existsSync(join(repo, CHANGE_DIR))).toBe(false);
  });
});
