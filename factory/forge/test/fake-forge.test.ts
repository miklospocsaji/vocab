import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeForge } from "../src/testing.ts";
import { describeForgeContract } from "./forge-contract.ts";

const DEFAULT_SHA = "fedcba9876543210fedcba9876543210fedcba98";

describeForgeContract("FakeForge", () => {
  const forge = new FakeForge({ defaultBranch: "master", defaultSha: DEFAULT_SHA });
  return {
    forge,
    defaultBranch: "master",
    defaultSha: DEFAULT_SHA,
    addIssue: (issue) => {
      forge.addIssue(issue);
    },
    setBranch: (branch, sha) => {
      forge.setBranch(branch, sha);
    },
    comments: (n) => forge.comments.filter((c) => c.issueNumber === n).map((c) => c.body),
    branchSha: (branch) => forge.branchSha(branch),
  };
});

describe("FakeForge", () => {
  it("can be seeded with issues up front", async () => {
    const forge = new FakeForge({ issues: [{ number: 12, title: "Import Kindle vocab.db", body: "Read vocab.db" }] });

    expect(await forge.getIssue(12)).toMatchObject({ number: 12, title: "Import Kindle vocab.db", body: "Read vocab.db", state: "open" });
    expect(await forge.branchExists("master")).toBe(true);
  });

  describe("pushBranch", () => {
    let root: string;

    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();

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
});
