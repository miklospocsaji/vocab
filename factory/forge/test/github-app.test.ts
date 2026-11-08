/**
 * GitHub App auth for the Forge (add-factory-worker task 1.10): the installation token
 * provider and GitHubForge built with it, over the emulated GitHub API with a test RSA key
 * generated here. Only `Date` is faked, so token lifetimes can be stepped through.
 */
import { generateKeyPairSync, verify } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appCommitter,
  createInstallationTokenProvider,
  ForgeError,
  GitHubForge,
  type InstallationTokenProviderOptions,
  type RunGit,
  type TokenProvider,
} from "../src/index.ts";
import { FakeGitHubApi } from "./fake-github-api.ts";
import { describeForgeContract } from "./forge-contract.ts";

const OWNER = "miklospocsaji";
const REPO = "vocab";
const APP_ID = 5586098;
const INSTALLATION_ID = 177972181;
const DEFAULT_BRANCH = "main";
const DEFAULT_SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN_PATH = `/app/installations/${String(INSTALLATION_ID)}/access_tokens`;
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const MINUTE = 60_000;

// GitHub hands out App keys as PKCS#1 PEM.
const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
/** One line of the key's body, so a partial leak is caught too. */
const KEY_LINE = PRIVATE_KEY.split("\n")[1] ?? "";

function fakeApi(): FakeGitHubApi {
  return new FakeGitHubApi({
    owner: OWNER,
    repo: REPO,
    defaultBranch: DEFAULT_BRANCH,
    defaultSha: DEFAULT_SHA,
    app: { appId: APP_ID, installationId: INSTALLATION_ID, publicKey: PUBLIC_KEY },
  });
}

function provider(api: FakeGitHubApi, overrides: Partial<InstallationTokenProviderOptions> = {}): TokenProvider {
  return createInstallationTokenProvider({
    appId: APP_ID,
    installationId: INSTALLATION_ID,
    privateKey: PRIVATE_KEY,
    repository: REPO,
    fetch: api.fetch,
    ...overrides,
  });
}

function setup(options: { git?: RunGit } = {}) {
  const api = fakeApi();
  const logged: string[] = [];
  const log = {
    debug: (m: string) => logged.push(m),
    info: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(m),
  };
  const forge = new GitHubForge({ owner: OWNER, repo: REPO, token: provider(api), fetch: api.fetch, log, ...options });
  return { api, forge, logged };
}

const issue = (number: number) => ({ number, title: "Import Kindle vocab.db", body: "Read vocab.db", state: "open" as const });

const unauthorized = () =>
  new Response(JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

/** The JWT the provider sent with each token request. */
function jwtsSent(api: FakeGitHubApi): string[] {
  return api.requests.filter((r) => r.path === TOKEN_PATH).map((r) => (r.authorization ?? "").replace(/^bearer /i, ""));
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Nothing in the text holds a token, a JWT or the App's private key. */
function expectNoSecrets(text: string, secrets: string[]): void {
  expect(text).not.toContain(PRIVATE_KEY);
  expect(text).not.toContain(KEY_LINE);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createInstallationTokenProvider", () => {
  it("Scenario: Installation token is scoped to the repository", async () => {
    const api = fakeApi();

    const token = await provider(api)();

    expect(api.issuedTokens).toHaveLength(1);
    expect(token).toBe(api.issuedTokens[0]?.token);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${TOKEN_PATH}`]);
    expect(api.requests[0]?.body).toEqual({
      repositories: [REPO],
      permissions: { contents: "write", issues: "write", metadata: "read" },
    });

    // A JWT for the App: RS256, signed with its key, issued by its id, valid for at most 10 minutes.
    expect(api.requests[0]?.authorization).toMatch(/^Bearer /);
    const [jwt] = jwtsSent(api);
    const [header = "", payload = "", signature = ""] = (jwt ?? "").split(".");
    expect(decode(header)).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), PUBLIC_KEY, Buffer.from(signature, "base64url"))).toBe(true);
    const claims = decode(payload);
    expect(String(claims["iss"])).toBe(String(APP_ID));
    const now = T0 / 1000;
    const iat = Number(claims["iat"]);
    const exp = Number(claims["exp"]);
    expect(iat).toBeLessThanOrEqual(now);
    expect(exp).toBeGreaterThan(now);
    expect(exp - iat).toBeLessThanOrEqual(600);
    expect(exp - now).toBeLessThanOrEqual(600);
  });

  it("reuses its token while more than five minutes of it are left", async () => {
    const api = fakeApi();
    const tokens = provider(api);

    const first = await tokens();
    vi.setSystemTime(T0 + 54 * MINUTE);
    const second = await tokens();

    expect(second).toBe(first);
    expect(api.issuedTokens).toHaveLength(1);
  });

  it("requests a single token for concurrent callers", async () => {
    const api = fakeApi();
    const tokens = provider(api);

    const [a, b, c] = await Promise.all([tokens(), tokens(), tokens()]);

    expect(api.issuedTokens).toHaveLength(1);
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it("rejects a refused token request with an unauthorized ForgeError that holds neither the JWT nor the key", async () => {
    const api = fakeApi();
    api.intercept = (request) => (request.path === TOKEN_PATH ? unauthorized() : undefined);

    const error = await provider(api)().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
    expect((error as Error).message).toMatch(/installation token/);
    expectNoSecrets(inspect(error, { depth: Infinity, showHidden: true }), jwtsSent(api));
  });

  it("rejects an unusable private key without putting the key in the error", async () => {
    const api = fakeApi();
    const broken = PRIVATE_KEY.replace(KEY_LINE, KEY_LINE.split("").reverse().join(""));

    const error = await provider(api, { privateKey: broken })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const text = inspect(error, { depth: Infinity, showHidden: true });
    expect(text).not.toContain(broken);
    expectNoSecrets(text, []);
    expect(api.issuedTokens).toHaveLength(0);
  });

  it("never exposes the private key through inspect of the provider", () => {
    const tokens = provider(fakeApi());

    expectNoSecrets(inspect(tokens, { depth: Infinity, showHidden: true }), []);
  });
});

describeForgeContract("GitHubForge with a GitHub App token provider", () => {
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

describe("GitHubForge with a token provider", () => {
  it("sends the provider's token as the Authorization header of the repository calls", async () => {
    const { api, forge } = setup();
    api.issues.set(12, issue(12));

    await forge.getIssue(12);
    await forge.comment(12, "hello");

    const repoCalls = api.requests.filter((r) => r.path.startsWith(`/repos/${OWNER}/${REPO}`));
    expect(repoCalls).toHaveLength(2);
    expect(api.issuedTokens).toHaveLength(1);
    for (const call of repoCalls) expect(call.authorization).toBe(`token ${api.issuedTokens[0]?.token ?? ""}`);
  });

  it("Scenario: Expiring token is refreshed", async () => {
    const { api, forge } = setup();
    api.issues.set(12, issue(12));

    await forge.getIssue(12);
    // Six minutes left: the token is still used.
    vi.setSystemTime(T0 + 54 * MINUTE);
    await forge.getIssue(12);
    expect(api.issuedTokens).toHaveLength(1);

    // Four minutes left: a new token is requested first, and the call uses it.
    vi.setSystemTime(T0 + 56 * MINUTE);
    api.requests.length = 0;
    await forge.getIssue(12);

    expect(api.issuedTokens).toHaveLength(2);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${TOKEN_PATH}`, `GET /repos/${OWNER}/${REPO}/issues/12`]);
    expect(api.requests[1]?.authorization).toBe(`token ${api.issuedTokens[1]?.token ?? ""}`);
  });

  it("pushes with the provider's current token, only through the credential helper", async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const git: RunGit = (args, { env }) => {
      calls.push({ args, env });
      return Promise.resolve();
    };
    const { api, forge } = setup({ git });

    await forge.pushBranch({ worktree: "/work/add-x", branch: "add-x" });
    vi.setSystemTime(T0 + 56 * MINUTE);
    await forge.pushBranch({ worktree: "/work/add-x", branch: "add-x" });

    expect(api.issuedTokens).toHaveLength(2);
    expect(calls.map((call) => call.env["FACTORY_GITHUB_TOKEN"])).toEqual(api.issuedTokens.map((issued) => issued.token));
    for (const [index, call] of calls.entries()) {
      for (const arg of call.args) expect(arg).not.toContain(api.issuedTokens[index]?.token ?? "");
    }
  });

  it("Scenario: Token failures do not leak the token", async () => {
    // A push that fails the way git does when it echoes the credential it was given.
    const git: RunGit = (_args, { env }) =>
      Promise.reject(
        new Error(`remote: Invalid username or password.\nfatal: Authentication failed for 'https://x-access-token:${env["FACTORY_GITHUB_TOKEN"] ?? ""}@github.com/${OWNER}/${REPO}.git/'`),
      );
    const { api, forge, logged } = setup({ git });
    api.issues.set(12, issue(12));
    await forge.getIssue(12);
    const token = api.issuedTokens[0]?.token ?? "";

    // A GitHub call refused with the current token.
    api.intercept = (request) => (request.path.startsWith(`/repos/`) ? unauthorized() : undefined);
    const callError = await forge.getIssue(12).catch((e: unknown) => e);
    // A push refused with it.
    api.intercept = undefined;
    const pushError = await forge.pushBranch({ worktree: "/work/add-x", branch: "add-x" }).catch((e: unknown) => e);
    // The token request itself refused, once the token is due for a refresh.
    vi.setSystemTime(T0 + 56 * MINUTE);
    api.intercept = (request) => (request.path === TOKEN_PATH ? unauthorized() : undefined);
    const refreshError = await forge.getIssue(12).catch((e: unknown) => e);

    expect(callError).toBeInstanceOf(ForgeError);
    expect(callError).toMatchObject({ kind: "unauthorized", status: 401 });
    expect((callError as Error).message).toContain("reading issue #12");
    expect(pushError).toBeInstanceOf(ForgeError);
    expect((pushError as Error).message).toMatch(/pushing branch add-x failed: .*Authentication failed/s);
    expect(refreshError).toBeInstanceOf(ForgeError);
    expect(refreshError).toMatchObject({ kind: "unauthorized" });
    expect((refreshError as Error).message).toMatch(/installation token/);

    const secrets = [token, ...jwtsSent(api)];
    expect(token).not.toBe("");
    for (const error of [callError, pushError, refreshError]) {
      expectNoSecrets(inspect(error, { depth: Infinity, showHidden: true }), secrets);
      expectNoSecrets(JSON.stringify(error), secrets);
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expectNoSecrets(line, secrets);
    expectNoSecrets(inspect(forge, { depth: Infinity, showHidden: true }), secrets);
    expectNoSecrets(JSON.stringify(forge), secrets);
  });
});

describe("appCommitter", () => {
  const SLUG = "vocab-factory";
  const BOT_ID = 41898282;
  const APP_TOKEN = "ghs_installationTokenForTests0123456789";

  function usersApi(response: () => Response) {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return Promise.resolve(response());
    };
    return { requests, fetch: fetchFn };
  }

  it("is the App's bot user, with GitHub's noreply address for its user id", async () => {
    const api = usersApi(() => Response.json({ login: `${SLUG}[bot]`, id: BOT_ID, type: "Bot" }));

    const committer = await appCommitter({ slug: SLUG, token: () => Promise.resolve(APP_TOKEN), fetch: api.fetch });

    expect(committer).toEqual({ name: `${SLUG}[bot]`, email: `${String(BOT_ID)}+${SLUG}[bot]@users.noreply.github.com` });
    expect(api.requests).toEqual([{ url: `https://api.github.com/users/${encodeURIComponent(`${SLUG}[bot]`)}`, authorization: `token ${APP_TOKEN}` }]);
  });

  it("fails with a ForgeError that does not contain the token", async () => {
    const api = usersApi(() => unauthorized());

    const error = await appCommitter({ slug: SLUG, token: () => Promise.resolve(APP_TOKEN), fetch: api.fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
    expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(APP_TOKEN);
  });

  it("fails when the user is not the App's bot", async () => {
    const api = usersApi(() => Response.json({ login: "someone", id: 1, type: "User" }));

    await expect(appCommitter({ slug: SLUG, fetch: api.fetch })).rejects.toBeInstanceOf(ForgeError);
  });
});
