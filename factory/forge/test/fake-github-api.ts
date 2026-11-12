/**
 * An in-memory GitHub REST API for the few endpoints GitHubForge calls, served through an
 * injected `fetch`, so GitHubForge tests never touch the network. With `app` set it also
 * plays the factory's GitHub App: it issues installation tokens for a JWT signed with the
 * App's key, and accepts those tokens until they expire.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

export interface ApiIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  /** GitHub's issues endpoint also returns pull requests, marked by this field. */
  pullRequest?: boolean;
}

export interface RecordedRequest {
  method: string;
  /** The path, decoded, without the base URL or query. */
  path: string;
  /** The query parameters, decoded. */
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
}

export interface ApiPullRequest {
  number: number;
  /** The head branch, in the same repository. */
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
}

export interface FakeGitHubApp {
  appId: number;
  installationId: number;
  /** The App's public key; the token endpoint verifies the JWT against it. */
  publicKey: KeyObject | string;
  /** How long an issued token lasts; GitHub's is an hour. */
  tokenLifetimeMs?: number;
}

export interface FakeGitHubApiOptions {
  owner: string;
  repo: string;
  /** A fixed token the repository endpoints accept, like the owner's `gh` token. */
  token?: string;
  defaultBranch: string;
  defaultSha: string;
  app?: FakeGitHubApp;
}

export interface IssuedToken {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** The JSON body of the token request. */
  request: unknown;
}

/** Return a Response to answer a request before the emulator does, or undefined to pass. */
export type Intercept = (request: RecordedRequest) => Response | undefined;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const notFound = () => json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" });

export class FakeGitHubApi {
  readonly requests: RecordedRequest[] = [];
  readonly issues = new Map<number, ApiIssue>();
  readonly comments = new Map<number, string[]>();
  /** Branch name to head sha. */
  readonly branches = new Map<string, string>();
  /** Pull requests, in the order they were opened. */
  readonly pullRequests: ApiPullRequest[] = [];
  /** The installation tokens issued so far, in order. */
  readonly issuedTokens: IssuedToken[] = [];
  intercept: Intercept | undefined;

  readonly #options: FakeGitHubApiOptions;
  #nextCommentId = 1;
  #nextPullNumber = 100;

  constructor(options: FakeGitHubApiOptions) {
    this.#options = options;
    this.branches.set(options.defaultBranch, options.defaultSha);
  }

  /** The `fetch` to inject. Any other host fails the test loudly. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com") throw new Error(`unexpected request to ${url.origin}`);
    const text = await request.text();
    const recorded: RecordedRequest = {
      method: request.method,
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get("authorization"),
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
    this.requests.push(recorded);
    return this.intercept?.(recorded) ?? this.#handle(recorded);
  };

  #handle(request: RecordedRequest): Response {
    const { owner, repo, defaultBranch, app } = this.#options;
    const [scheme, credential] = (request.authorization ?? "").split(" ");
    const badCredentials = () => json(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" });

    if (app !== undefined && request.path === `/app/installations/${String(app.installationId)}/access_tokens`) {
      if (request.method !== "POST" || !/^bearer$/i.test(scheme ?? "") || !validAppJwt(credential ?? "", app)) return badCredentials();
      const expiresAt = Date.now() + (app.tokenLifetimeMs ?? 3_600_000);
      const token = `ghs_fakeInstallationToken${String(this.issuedTokens.length + 1).padStart(4, "0")}abcdefXYZ`;
      this.issuedTokens.push({ token, expiresAt, request: request.body });
      return json(201, { token, expires_at: new Date(expiresAt).toISOString() });
    }

    if (!/^(token|bearer)$/i.test(scheme ?? "") || credential === undefined || !this.#accepts(credential)) return badCredentials();

    const prefix = `/repos/${owner}/${repo}`;
    if (!request.path.startsWith(prefix)) return notFound();
    const rest = request.path.slice(prefix.length);
    const route = `${request.method} ${rest}`;

    if (route === "GET ") {
      return json(200, { full_name: `${owner}/${repo}`, default_branch: defaultBranch });
    }

    const issue = /^GET \/issues\/(\d+)$/.exec(route);
    if (issue) {
      const found = this.issues.get(Number(issue[1]));
      if (found === undefined) return notFound();
      const kind = found.pullRequest === true ? "pull" : "issues";
      return json(200, {
        number: found.number,
        title: found.title,
        body: found.body,
        state: found.state,
        html_url: `https://github.com/${owner}/${repo}/${kind}/${String(found.number)}`,
        ...(found.pullRequest === true ? { pull_request: { url: `https://api.github.com${prefix}/pulls/${String(found.number)}` } } : {}),
      });
    }

    const comment = /^POST \/issues\/(\d+)\/comments$/.exec(route);
    if (comment) {
      const issueNumber = Number(comment[1]);
      if (!this.issues.has(issueNumber)) return notFound();
      const { body } = request.body as { body?: unknown };
      if (typeof body !== "string") return json(422, { message: "Validation Failed" });
      this.comments.set(issueNumber, [...(this.comments.get(issueNumber) ?? []), body]);
      return json(201, { id: this.#nextCommentId++, body });
    }

    const ref = /^GET \/git\/ref\/heads\/(.+)$/.exec(route);
    if (ref) {
      const name = ref[1] ?? "";
      const sha = this.branches.get(name);
      if (sha === undefined) return notFound();
      return json(200, { ref: `refs/heads/${name}`, object: { sha, type: "commit" } });
    }

    if (route === "POST /git/refs") {
      const { ref: full, sha } = request.body as { ref?: unknown; sha?: unknown };
      if (typeof full !== "string" || !full.startsWith("refs/heads/") || typeof sha !== "string") {
        return json(422, { message: "Validation Failed" });
      }
      const name = full.slice("refs/heads/".length);
      if (this.branches.has(name)) return json(422, { message: "Reference already exists" });
      this.branches.set(name, sha);
      return json(201, { ref: full, object: { sha, type: "commit" } });
    }

    if (route === "POST /pulls") {
      const { head, base, title, body } = request.body as { head?: unknown; base?: unknown; title?: unknown; body?: unknown };
      if (typeof head !== "string" || typeof base !== "string" || typeof title !== "string") return json(422, { message: "Validation Failed" });
      // Same-repository heads only, as the factory opens them; `owner:branch` names the same thing.
      const branch = head.startsWith(`${owner}:`) ? head.slice(owner.length + 1) : head;
      if (!this.branches.has(branch) || !this.branches.has(base)) {
        return json(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] });
      }
      if (this.pullRequests.some((pr) => pr.head === branch && pr.state === "open")) {
        return json(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: `A pull request already exists for ${owner}:${branch}.` }] });
      }
      const pr: ApiPullRequest = { number: this.#nextPullNumber++, head: branch, base, title, body: typeof body === "string" ? body : "", state: "open" };
      this.pullRequests.push(pr);
      return json(201, this.#pullJson(pr));
    }

    if (route === "GET /pulls") {
      const head = request.query["head"];
      const state = request.query["state"] ?? "open";
      const matches = this.pullRequests.filter(
        (pr) => (head === undefined || `${owner}:${pr.head}` === head) && (state === "all" || pr.state === state),
      );
      return json(200, matches.map((pr) => this.#pullJson(pr)));
    }

    return notFound();
  }

  #pullJson(pr: ApiPullRequest): Record<string, unknown> {
    const { owner, repo } = this.#options;
    return {
      number: pr.number,
      html_url: `https://github.com/${owner}/${repo}/pull/${String(pr.number)}`,
      state: pr.state,
      title: pr.title,
      body: pr.body === "" ? null : pr.body,
      head: { ref: pr.head, label: `${owner}:${pr.head}` },
      base: { ref: pr.base, label: `${owner}:${pr.base}` },
    };
  }

  /** The fixed token, or an installation token that has not expired. */
  #accepts(credential: string): boolean {
    if (this.#options.token !== undefined && credential === this.#options.token) return true;
    return this.issuedTokens.some((issued) => issued.token === credential && Date.now() < issued.expiresAt);
  }
}

/** An RS256 JWT signed with the App's key, issued by the App, and not expired. */
function validAppJwt(jwt: string, app: FakeGitHubApp): boolean {
  const [header, payload, signature] = jwt.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return false;
  const key = typeof app.publicKey === "string" ? createPublicKey(app.publicKey) : app.publicKey;
  if (!verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url"))) return false;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: unknown; exp?: unknown };
  return String(claims.iss) === String(app.appId) && typeof claims.exp === "number" && claims.exp * 1000 > Date.now();
}
