/**
 * `pnpm factory <command>`: the CLI with its real dependencies.
 * - `.env.local` at the repo root (git-ignored) is loaded first, for `CLAUDE_CODE_OAUTH_TOKEN`
 *   (ADR 0006) and optionally `FACTORY_DATABASE_URL`. Variables already set win.
 * - The ledger is the Postgres at `FACTORY_DATABASE_URL`, migrated on start-up.
 * - `run` reads the owner's token with `gh auth token`, talks to the GitHub repository of
 *   this checkout's `origin`, and runs roles through the Agent SDK. The token is never logged.
 * Exit codes are `EXIT_CODES` in cli.ts.
 */
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ghAuthToken, GitHubForge } from "@vocab/factory-forge";
import { databaseUrl, LedgerRecorder, migrate } from "@vocab/factory-ledger";
import { createRunner, loadRole } from "@vocab/factory-roles";
import pg from "pg";
import { EXIT_CODES, runCli } from "./cli.ts";
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
        const { owner, repo } = parseGitHubRemote(await originUrl());
        return {
          forge: new GitHubForge({ owner, repo, token }),
          runRole: createRunner({ recorder: new LedgerRecorder(pool) }),
          role: await loadRole(PROPOSAL_AUTHOR),
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
