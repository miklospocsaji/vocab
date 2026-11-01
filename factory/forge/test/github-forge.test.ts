import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeError, GitHubForge, type GitHubForgeOptions, type RunGit } from "../src/index.ts";
import { FakeGitHubApi } from "./fake-github-api.ts";
import { describeForgeContract } from "./forge-contract.ts";

const OWNER = "miklospocsaji";
const REPO = "vocab";
const TOKEN = "gho_fakeTokenForTests0123456789abcdefXYZ";
const DEFAULT_BRANCH = "main";
const DEFAULT_SHA = "0123456789abcdef0123456789abcdef01234567";

function setup(overrides: Partial<GitHubForgeOptions> = {}) {
  const api = new FakeGitHubApi({ owner: OWNER, repo: REPO, token: TOKEN, defaultBranch: DEFAULT_BRANCH, defaultSha: DEFAULT_SHA });
  const logged: string[] = [];
  const log = {
    debug: (m: string) => logged.push(m),
    info: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(m),
  };
  const forge = new GitHubForge({ owner: OWNER, repo: REPO, token: TOKEN, fetch: api.fetch, log, ...overrides });
  return { api, forge, logged };
}

const issue = (number: number, title = "Import Kindle vocab.db", body: string | null = "Read vocab.db") => ({ number, title, body, state: "open" as const });

describeForgeContract("GitHubForge", () => {
  const { api, forge } = setup();
  return {
    forge,
    defaultBranch: DEFAULT_BRANCH,
    defaultSha: DEFAULT_SHA,
    otherSha: "1111111111111111111111111111111111111111",
    addIssue: (i) => api.issues.set(i.number, i),
    setBranch: (branch, sha) => api.branches.set(branch, sha),
    comments: (n) => api.comments.get(n) ?? [],
    branchSha: (branch) => api.branches.get(branch),
  };
});

describe("GitHubForge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never touches the network: every call goes through the injected fetch", async () => {
    const globalFetch = vi.fn(() => Promise.reject(new Error("network used")));
    vi.stubGlobal("fetch", globalFetch);
    const { api, forge } = setup();
    api.issues.set(12, issue(12));

    await forge.getIssue(12);
    await forge.comment(12, "hi");
    await forge.branchExists("add-x");
    await forge.createBranch("add-x");

    expect(globalFetch).not.toHaveBeenCalled();
    expect(api.requests.length).toBeGreaterThanOrEqual(4);
  });

  it("calls the repository's endpoints with the token as the Authorization header", async () => {
    const { api, forge } = setup();
    api.issues.set(12, issue(12));

    await forge.getIssue(12);
    await forge.comment(12, "hello");

    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /repos/${OWNER}/${REPO}/issues/12`, `POST /repos/${OWNER}/${REPO}/issues/12/comments`]);
    expect(api.requests.every((r) => r.authorization === `token ${TOKEN}`)).toBe(true);
    expect(api.requests[1]?.body).toEqual({ body: "hello" });
  });

  it("creates the branch from the head of the repository's default branch, whatever it is called", async () => {
    const { api, forge } = setup();

    await forge.createBranch("add-x");

    expect(api.requests.find((r) => r.method === "POST")).toMatchObject({
      path: `/repos/${OWNER}/${REPO}/git/refs`,
      body: { ref: "refs/heads/add-x", sha: DEFAULT_SHA },
    });
  });

  it("treats a branch created by someone else between the check and the create as existing", async () => {
    const { api, forge } = setup();
    const racedSha = "2222222222222222222222222222222222222222";
    api.intercept = (request) => {
      if (request.method !== "POST" || !request.path.endsWith("/git/refs")) return undefined;
      api.branches.set("add-x", racedSha);
      return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422, headers: { "content-type": "application/json" } });
    };

    expect(await forge.createBranch("add-x")).toEqual({ created: false, sha: racedSha });
  });

  it("rejects a pull request number as not-found, since it is not an issue", async () => {
    const { api, forge } = setup();
    api.issues.set(7, { ...issue(7), pullRequest: true });

    const error = await forge.getIssue(7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ kind: "not-found" });
  });

  it("rejects a bad token with an unauthorized ForgeError", async () => {
    const { api, forge } = setup({ token: "gho_wrong" });
    api.issues.set(12, issue(12));

    const error = await forge.getIssue(12).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
  });

  it("rejects a server error with a failed ForgeError that carries the status", async () => {
    const { api, forge } = setup();
    api.intercept = () => new Response(JSON.stringify({ message: "Server Error" }), { status: 500, headers: { "content-type": "application/json" } });

    const error = await forge.comment(12, "hi").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ kind: "failed", status: 500 });
  });

  it("never logs or exposes the token, not even in errors", async () => {
    const { api, forge, logged } = setup();
    api.issues.set(12, issue(12));

    await forge.getIssue(12);
    await forge.comment(12, "hi");
    await forge.createBranch("add-x");
    api.intercept = () => new Response(JSON.stringify({ message: "Server Error" }), { status: 500, headers: { "content-type": "application/json" } });
    const error = await forge.getIssue(12).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(TOKEN);
    expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(inspect(forge, { depth: Infinity, showHidden: true })).not.toContain(TOKEN);
    expect(JSON.stringify(forge)).not.toContain(TOKEN);
  });
});

describe("GitHubForge.pushBranch", () => {
  interface GitCall {
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }

  function recordingGit() {
    const calls: GitCall[] = [];
    const git: RunGit = (args, options) => {
      calls.push({ args, ...options });
      return Promise.resolve();
    };
    return { calls, git };
  }

  beforeEach(() => {
    // Keep the owner's and the system's git config (credential helpers above all) out of the tests.
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pushes the branch to the repository's plain HTTPS URL, with no token in the URL or the arguments", async () => {
    const { calls, git } = recordingGit();
    const { forge } = setup({ git });

    await forge.pushBranch({ worktree: "/work/add-x", branch: "add-x" });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.cwd).toBe("/work/add-x");
    const args = call?.args ?? [];
    expect(args.slice(args.indexOf("push"))).toEqual(["push", `https://github.com/${OWNER}/${REPO}.git`, "refs/heads/add-x:refs/heads/add-x"]);
    for (const arg of args) expect(arg).not.toContain(TOKEN);
    expect(call?.env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("supplies the token only through its own credential helper, after clearing inherited ones", async () => {
    const { calls, git } = recordingGit();
    const { forge } = setup({ git });

    await forge.pushBranch({ worktree: "/work/add-x", branch: "add-x" });

    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    const config = call.args.slice(0, call.args.indexOf("push"));
    const helpers = config.filter((arg) => arg.startsWith("credential.helper="));
    expect(helpers[0]).toBe("credential.helper=");
    expect(helpers).toHaveLength(2);

    // Ask git itself, with the same config and environment, what credentials it would send.
    const filled = execFileSync("git", [...config, "credential", "fill"], {
      env: call.env,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    expect(filled).toContain("username=x-access-token\n");
    expect(filled).toContain(`password=${TOKEN}\n`);
  });

  it("rejects a failed push with a failed ForgeError that does not contain the token", async () => {
    const git: RunGit = () => Promise.reject(new Error("remote: Permission denied\nfatal: unable to access"));
    const { forge } = setup({ git });

    const error = await forge.pushBranch({ worktree: "/work/add-x", branch: "add-x" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ kind: "failed" });
    expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(TOKEN);
  });

  it("really pushes with the default git runner (to a local file remote, so no network)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-forge-")));
    try {
      const run = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
      const remote = join(root, "hosts", OWNER, `${REPO}.git`);
      mkdirSync(remote, { recursive: true });
      run(remote, "init", "--bare", "-b", DEFAULT_BRANCH);
      const worktree = join(root, "work");
      run(root, "init", "-b", "add-x", worktree);
      writeFileSync(join(worktree, "README.md"), "# vocab\n");
      run(worktree, "add", "-A");
      run(worktree, "commit", "-m", "initial");
      const sha = run(worktree, "rev-parse", "HEAD");
      const { forge } = setup({ gitBaseUrl: `file://${join(root, "hosts")}` });

      await forge.pushBranch({ worktree, branch: "add-x" });

      expect(run(remote, "rev-parse", "refs/heads/add-x")).toBe(sha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
