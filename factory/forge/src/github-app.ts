/**
 * GitHub App installation tokens for the Forge (ADR 0009). The provider signs a short-lived
 * RS256 JWT with the App's private key (`node:crypto`, no dependency), exchanges it for an
 * installation token scoped to one repository with the factory's permissions, and caches the
 * token until five minutes before it expires.
 *
 * The key, the JWT and the token live only in this closure, never in an object that could be
 * inspected or serialised, and no error message carries any of them.
 */
import { sign } from "node:crypto";
import { ForgeError, type ForgeErrorKind } from "./forge.ts";

/** Resolves to a currently valid token; GitHubForge calls it before every request and push. */
export type TokenProvider = () => Promise<string>;

export interface InstallationTokenProviderOptions {
  appId: number;
  installationId: number;
  /** The App's private key (PEM); never logged or put in an error. */
  privateKey: string;
  /** The repository's name, without the owner: the only repository the token covers. */
  repository: string;
  /** Defaults to the global `fetch`; tests inject one so nothing reaches the network. */
  fetch?: typeof fetch;
  /** The REST API root; defaults to `https://api.github.com`. */
  baseUrl?: string;
}

/** ADR 0009: exactly these, and pull requests join in M3. */
const PERMISSIONS = { contents: "write", issues: "write", metadata: "read" } as const;
/** A token is replaced once less than this is left of it. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** GitHub allows up to 10 minutes; `iat` is backdated for clock drift, as GitHub recommends. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;

const WHAT = "GitHub App: requesting an installation token failed";

interface CachedToken {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export function createInstallationTokenProvider(options: InstallationTokenProviderOptions): TokenProvider {
  const { appId, installationId, privateKey, repository } = options;
  const fetchFn = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "")}/app/installations/${String(installationId)}/access_tokens`;
  let cached: CachedToken | undefined;
  let pending: Promise<string> | undefined;

  const request = async (): Promise<string> => {
    const jwt = appJwt(appId, privateKey);
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ repositories: [repository], permissions: PERMISSIONS }),
      });
    } catch (error) {
      // No `cause`: a fetch error may carry the request, and with it the JWT.
      throw new ForgeError(`${WHAT}: ${scrub(messageOf(error), [jwt])}`, "failed");
    }

    const body = await readJson(response);
    if (!response.ok) {
      const kind: ForgeErrorKind = response.status === 401 ? "unauthorized" : response.status === 404 ? "not-found" : "failed";
      const detail = typeof body?.["message"] === "string" ? ` ${body["message"]}` : "";
      throw new ForgeError(`${WHAT}: ${String(response.status)}${scrub(detail, [jwt])}`, kind, response.status);
    }
    const token = body?.["token"];
    const expiresAt = typeof body?.["expires_at"] === "string" ? Date.parse(body["expires_at"]) : Number.NaN;
    if (typeof token !== "string" || token === "" || Number.isNaN(expiresAt)) {
      throw new ForgeError(`${WHAT}: the response has no token or expiry`, "failed", response.status);
    }
    cached = { token, expiresAt };
    return token;
  };

  return () => {
    if (cached !== undefined && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) return Promise.resolve(cached.token);
    // Concurrent callers share one request.
    pending ??= request().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** An RS256 JWT issued by the App, valid for under 10 minutes. */
function appJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT" });
  const payload = base64url({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: appId });
  let signature: Buffer;
  try {
    signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  } catch {
    // OpenSSL's message is not needed, and nothing about the key goes into the error.
    throw new ForgeError("GitHub App: signing the JWT failed: the private key cannot be used", "failed");
  }
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function scrub(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => (secret === "" ? result : result.replaceAll(secret, "[REDACTED]")), text);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
