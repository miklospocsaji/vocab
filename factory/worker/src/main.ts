/**
 * `factory-worker <state> --issue <n>`: the worker with its real dependencies, the entry
 * point of the `factory-worker` image (ADR 0010).
 * - The command line is checked first, so invalid input exits 2 with no configuration,
 *   database or network.
 * - Configuration comes from the environment (`config.ts`). The App's private key and the
 *   database URL are removed from `process.env` once read, so no child process inherits them.
 * - The Forge is the factory's GitHub App (ADR 0009), and commits are its bot user's.
 * - The clone and the worktrees live in a temp home, removed at the end.
 * Nothing printed contains a secret: errors from the Forge are scrubbed of tokens, and
 * configuration errors name a variable only. Exit codes are `WORKER_EXIT` in worker.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCommitter, createInstallationTokenProvider, GitHubForge } from "@vocab/factory-forge";
import { DATABASE_URL_VAR, LedgerRecorder } from "@vocab/factory-ledger";
import { createRunner, loadRole } from "@vocab/factory-roles";
import pg from "pg";
import { ENV, parseWorkerArgs, USAGE, WorkerConfigError, workerConfig } from "./config.ts";
import { runWorker, WORKER_EXIT } from "./worker.ts";

const PROPOSAL_AUTHOR = "proposal-author";

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

async function main(argv: string[]): Promise<number> {
  const args = parseWorkerArgs(argv);
  if (!args.ok) {
    err(`factory-worker: ${args.message}\n\n${USAGE}`);
    return WORKER_EXIT.invalid;
  }

  let config;
  try {
    config = workerConfig(process.env);
  } catch (error) {
    if (!(error instanceof WorkerConfigError)) throw error;
    err(`factory-worker: ${error.message}\n`);
    return WORKER_EXIT.invalid;
  }
  // Read once; no child process (git, openspec, the role session) needs them.
  Reflect.deleteProperty(process.env, ENV.privateKey);
  Reflect.deleteProperty(process.env, DATABASE_URL_VAR);

  const token = createInstallationTokenProvider({
    appId: config.app.appId,
    installationId: config.app.installationId,
    privateKey: config.app.privateKey,
    repository: config.repo,
  });
  const committer = await appCommitter({ slug: config.app.slug, token });
  const forge = new GitHubForge({ owner: config.owner, repo: config.repo, token, committer });

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const home = await mkdtemp(join(tmpdir(), "factory-worker-"));
  try {
    return await runWorker(argv, {
      db: pool,
      forge,
      runRole: createRunner({ recorder: new LedgerRecorder(pool) }),
      role: await loadRole(PROPOSAL_AUTHOR),
      home,
      committer,
      out,
      err,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
    await pool.end();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  err(`factory-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = WORKER_EXIT.error;
}
