/**
 * An in-memory GitHub REST API for the few endpoints GitHubForge calls, served through an
 * injected `fetch`, so GitHubForge tests never touch the network.
 */

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
  authorization: string | null;
  body: unknown;
}

export interface FakeGitHubApiOptions {
  owner: string;
  repo: string;
  token: string;
  defaultBranch: string;
  defaultSha: string;
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
  intercept: Intercept | undefined;

  readonly #options: FakeGitHubApiOptions;
  #nextCommentId = 1;

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
      authorization: request.headers.get("authorization"),
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
    this.requests.push(recorded);
    return this.intercept?.(recorded) ?? this.#handle(recorded);
  };

  #handle(request: RecordedRequest): Response {
    const { owner, repo, token, defaultBranch } = this.#options;
    const [scheme, credential] = (request.authorization ?? "").split(" ");
    if (!/^(token|bearer)$/i.test(scheme ?? "") || credential !== token) {
      return json(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" });
    }

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

    return notFound();
  }
}
