/**
 * `pnpm factory <command>`: the CLI with its real dependencies.
 * - `.env.local` at the repo root (git-ignored) is loaded first, for `CLAUDE_CODE_OAUTH_TOKEN`
 *   (ADR 0006) and optionally `FACTORY_DATABASE_URL`. Variables already set win.
 * - The ledger is the Postgres at `FACTORY_DATABASE_URL`, migrated on start-up.
 * - `run` and `approve` read the owner's token with `gh auth token`, talk to the GitHub repository
 *   of this checkout's `origin`, and run roles through the Agent SDK. The token is never logged.
 * - Builds run in the locally built `build` image through Docker, with the artifact store at
 *   `<factory home>/store` and only `CLAUDE_CODE_OAUTH_TOKEN` passed in (add-build-loop design,
 *   "Local runs"). The image clones `origin` with no token.
 * Exit codes are `EXIT_CODES` in cli.ts.
 */
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ghAuthToken, GitHubForge } from "@vocab/factory-forge";
import { databaseUrl, LedgerRecorder, migrate } from "@vocab/factory-ledger";
import { factoryHome } from "@vocab/factory-orchestrator";
import { createRunner, loadRole } from "@vocab/factory-roles";
import { FsStore } from "@vocab/factory-worker/store";
import pg from "pg";
import { EXIT_CODES, runCli } from "./cli.ts";
import { dockerBuildRunner } from "./docker-build.ts";
import { parseGitHubRemote } from "./github-remote.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PROPOSAL_AUTHOR = "proposal-author";

const execFileAsync = promisify(execFile);

function loadEnvLocal(): void {
  try {
    process.loadEnvFile(join(REPO_ROOT, ".env.local"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function originUrl(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT, encoding: "utf8" });
  return stdout.trim();
}

async function main(): Promise<number> {
  loadEnvLocal();
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    await migrate(pool);
    return await runCli(process.argv.slice(2), {
      db: pool,
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
      runContext: async () => {
        const token = await ghAuthToken();
        const origin = await originUrl();
        const { owner, repo } = parseGitHubRemote(origin);
        const storeDir = join(factoryHome(), "store");
        const [role, architect, designReviewer, planner, testAuthor, implementer, classifier] = await Promise.all(
          [PROPOSAL_AUTHOR, "architect", "design-reviewer", "planner", "test-author", "implementer", "failure-classifier"].map((name) => loadRole(name)),
        );
        if (role === undefined || architect === undefined || designReviewer === undefined || planner === undefined || testAuthor === undefined || implementer === undefined || classifier === undefined) {
          throw new Error("a role config is missing");
        }
        return {
          forge: new GitHubForge({ owner, repo, token }),
          runRole: createRunner({ recorder: new LedgerRecorder(pool) }),
          role,
          architect,
          designReviewer,
          planner,
          planPaths: { implementer: implementer.writable, testAuthor: testAuthor.writable },
          testAuthor,
          implementer,
          classifier,
          store: new FsStore(storeDir),
          runBuild: dockerBuildRunner({ storeDir, env: process.env }),
          cloneUrl: `https://github.com/${owner}/${repo}.git`,
          repo: REPO_ROOT,
        };
      },
    });
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT_CODES.error;
}
