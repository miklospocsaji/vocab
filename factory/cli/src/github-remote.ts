/** The owner and name of a GitHub repository. */
export interface GitHubRepository {
  owner: string;
  repo: string;
}

/**
 * Reads the owner and repository from a GitHub remote URL: `https://github.com/<owner>/<repo>(.git)`,
 * `git@github.com:<owner>/<repo>(.git)` or `ssh://git@github.com/<owner>/<repo>(.git)`.
 * Any other URL is an error.
 */
export function parseGitHubRemote(url: string): GitHubRepository {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  const [, owner, repo] = match ?? [];
  if (owner === undefined || repo === undefined) throw new Error(`origin is not a GitHub repository URL: ${redact(url)}`);
  return { owner, repo };
}

/** The URL without any credentials in it. */
function redact(url: string): string {
  return url.trim().replace(/\/\/[^@/]+@/, "//***@");
}
