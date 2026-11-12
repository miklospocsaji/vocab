import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeError } from "../src/index.ts";
import { FakeForge } from "../src/testing.ts";
import { describeForgeContract } from "./forge-contract.ts";

const DEFAULT_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();

describeForgeContract("FakeForge", () => {
  const forge = new FakeForge({ defaultBranch: "master", defaultSha: DEFAULT_SHA });
  return {
    forge,
    defaultBranch: "master",
    defaultSha: DEFAULT_SHA,
    otherSha: "1111111111111111111111111111111111111111",
    addIssue: (issue) => {
      forge.addIssue(issue);
    },
    setBranch: (branch, sha) => {
      forge.setBranch(branch, sha);
    },
    comments: (n) => forge.comments.filter((c) => c.issueNumber === n).map((c) => c.body),
    branchSha: (branch) => forge.branchSha(branch),
    pullRequests: () => forge.pullRequests.map(({ head, base, title, body }) => ({ head, base, title, body })),
  };
});

describe("FakeForge with a git remote", () => {
  let root: string;

  beforeAll(() => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    root = realpathSync(mkdtempSync(join(tmpdir(), "factory-fake-forge-remote-")));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  let n = 0;
  describeForgeContract("FakeForge with a git remote", () => {
    // A fresh bare repo per test, holding two real commits: master's head and another.
    const remote = join(root, `remote-${String(++n)}.git`);
    git(root, "init", "--bare", "-b", "master", remote);
    const tree = git(remote, "mktree", "--missing");
    const defaultSha = git(remote, "commit-tree", tree, "-m", "initial");
    const otherSha = git(remote, "commit-tree", tree, "-p", defaultSha, "-m", "other");
    git(remote, "update-ref", "refs/heads/master", defaultSha);

    const forge = new FakeForge({ remote });
    return {
      forge,
      defaultBranch: "master",
      defaultSha,
      otherSha,
      addIssue: (issue) => {
        forge.addIssue(issue);
      },
      setBranch: (branch, sha) => {
        forge.setBranch(branch, sha);
      },
      comments: (issueNumber) => forge.comments.filter((c) => c.issueNumber === issueNumber).map((c) => c.body),
      // Read from git itself, not through the forge under test.
      branchSha: (branch) => {
        try {
          return git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
        } catch {
          return undefined;
        }
      },
      pullRequests: () => forge.pullRequests.map(({ head, base, title, body }) => ({ head, base, title, body })),
    };
  });
});

describe("FakeForge", () => {
  it("can be seeded with issues up front", async () => {
    const forge = new FakeForge({ issues: [{ number: 12, title: "Import Kindle vocab.db", body: "Read vocab.db" }] });

    expect(await forge.getIssue(12)).toMatchObject({ number: 12, title: "Import Kindle vocab.db", body: "Read vocab.db", state: "open" });
    expect(await forge.branchExists("master")).toBe(true);
  });

  describe("pushBranch", () => {
    let root: string;

    beforeEach(() => {
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      root = realpathSync(mkdtempSync(join(tmpdir(), "factory-fake-forge-")));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    });

    it("pushes the worktree's branch to its origin and records the new head", async () => {
      const remote = join(root, "remote.git");
      git(root, "init", "--bare", "-b", "master", remote);
      const worktree = join(root, "work");
      git(root, "clone", remote, worktree);
      git(worktree, "checkout", "-b", "add-x");
      writeFileSync(join(worktree, "README.md"), "# vocab\n");
      git(worktree, "add", "-A");
      git(worktree, "commit", "-m", "propose add-x");
      const sha = git(worktree, "rev-parse", "HEAD");
      const forge = new FakeForge();

      await forge.pushBranch({ worktree, branch: "add-x" });

      expect(git(remote, "rev-parse", "refs/heads/add-x")).toBe(sha);
      expect(forge.branchSha("add-x")).toBe(sha);
      expect(await forge.branchExists("add-x")).toBe(true);
    });
  });

  describe("clone", () => {
    let root: string;

    beforeEach(() => {
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      root = realpathSync(mkdtempSync(join(tmpdir(), "factory-fake-forge-")));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    });

    it("clones its remote, which becomes the clone's origin", async () => {
      const remote = join(root, "remote.git");
      git(root, "init", "--bare", "-b", "master", remote);
      const seed = join(root, "seed");
      git(root, "clone", remote, seed);
      writeFileSync(join(seed, "README.md"), "# vocab\n");
      git(seed, "add", "-A");
      git(seed, "commit", "-m", "initial");
      git(seed, "push", "origin", "master");
      const forge = new FakeForge({ remote });
      const clone = join(root, "clone");

      await forge.clone(clone);

      expect(git(clone, "remote", "get-url", "origin")).toBe(remote);
      expect(git(clone, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "refs/heads/master"));
    });

    it("rejects without a remote, since there is nothing to clone", async () => {
      await expect(new FakeForge().clone(join(root, "clone"))).rejects.toBeInstanceOf(ForgeError);
    });
  });
});
