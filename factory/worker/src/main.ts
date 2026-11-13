/**
 * `factory-worker <state> --issue <n>`: the worker with its real dependencies, the entry
 * point of the `factory-worker` image (ADR 0010).
 * - The command line is checked first, so invalid input exits 2 with no configuration,
 *   database or network.
 * - Configuration comes from the environment (`config.ts`). The App's private key and the
 *   ledger's secret or URL are removed from `process.env` once read, so no child process
 *   inherits them.
 * - Each connection attempt is bounded, so `runWorker`'s wait for a resuming Aurora can retry.
 * - The Forge is the factory's GitHub App (ADR 0009), and commits are its bot user's.
 * - The clone and the worktrees live in a temp home, removed at the end.
 * - Step Functions and the artifact bucket (`FACTORY_STORE_BUCKET`) are reached with the task
 *   role's credentials, in the task's region. The build task clones the repository over public
 *   HTTPS with no token.
 * - Roles and prompts come from the image.
 * Nothing printed contains a secret: errors from the Forge are scrubbed of tokens, and
 * configuration errors name a variable only. Exit codes are `WORKER_EXIT` in worker.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { appCommitter, createInstallationTokenProvider, GitHubForge } from "@vocab/factory-forge";
import { DATABASE_URL_VAR, LEDGER_SECRET_VAR, LedgerRecorder } from "@vocab/factory-ledger";
import { createRunner, loadRole } from "@vocab/factory-roles";
import pg from "pg";
import { ENV, parseWorkerArgs, USAGE, WorkerConfigError, workerConfig } from "./config.ts";
import type { TaskTokens } from "@vocab/factory-orchestrator";
import { STORE_ENV, storeFromEnv, type ArtifactStore } from "./store.ts";
import { runWorker, WORKER_EXIT, type WorkerRoles } from "./worker.ts";

const PROPOSAL_AUTHOR = "proposal-author";
/** One connection attempt; runWorker's waitForLedger retries within its 180 s. */
const LEDGER_CONNECT_TIMEOUT_MS = 10_000;
/** The factory's region (brief, section 5), if the task's environment does not name one. */
const DEFAULT_REGION = "eu-central-1";

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
  // Only `step` uses the store; the other states run without one.
  const store = storeFromEnv(process.env) ?? missingStore();
  const taskToken = process.env[ENV.taskToken];
  // Read once; no child process (git, openspec, the role session) needs them.
  Reflect.deleteProperty(process.env, ENV.privateKey);
  Reflect.deleteProperty(process.env, DATABASE_URL_VAR);
  Reflect.deleteProperty(process.env, LEDGER_SECRET_VAR);
  Reflect.deleteProperty(process.env, ENV.taskToken);

  const token = createInstallationTokenProvider({
    appId: config.app.appId,
    installationId: config.app.installationId,
    privateKey: config.app.privateKey,
    repository: config.repo,
  });
  const committer = await appCommitter({ slug: config.app.slug, token });
  const forge = new GitHubForge({ owner: config.owner, repo: config.repo, token, committer });

  // A bounded connect, so a resuming Aurora is retried rather than waited on forever.
  const pool = new pg.Pool({ ...config.ledger, connectionTimeoutMillis: LEDGER_CONNECT_TIMEOUT_MS });
  const home = await mkdtemp(join(tmpdir(), "factory-worker-"));
  try {
    return await runWorker(argv, {
      db: pool,
      forge,
      runRole: createRunner({ recorder: new LedgerRecorder(pool) }),
      role: await loadRole(PROPOSAL_AUTHOR),
      roles: await loadRoles(),
      store,
      cloneUrl: `https://github.com/${config.owner}/${config.repo}.git`,
      home,
      committer,
      taskTokens: stepFunctions(),
      ...(taskToken === undefined ? {} : { taskToken }),
      out,
      err,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
    await pool.end();
  }
}

/** A store that fails every call, naming the variables that would configure one. */
function missingStore(): ArtifactStore {
  const fail = () => Promise.reject(new Error(`no artifact store: neither ${STORE_ENV.dir} nor ${STORE_ENV.bucket} is set`));
  return { get: fail, put: fail, exists: fail };
}

async function loadRoles(): Promise<WorkerRoles> {
  const [architect, designReviewer, planner, testAuthor, implementer, classifier] = await Promise.all(
    ["architect", "design-reviewer", "planner", "test-author", "implementer", "failure-classifier"].map((name) => loadRole(name)),
  );
  if (architect === undefined || designReviewer === undefined || planner === undefined || testAuthor === undefined || implementer === undefined || classifier === undefined) {
    throw new Error("a role config is missing");
  }
  return { architect, designReviewer, planner, testAuthor, implementer, classifier };
}

/** SendTaskSuccess and SendTaskFailure with the task role's credentials. */
function stepFunctions(): TaskTokens {
  const client = new SFNClient({ region: process.env["AWS_REGION"] ?? DEFAULT_REGION });
  return {
    async succeed(taskToken, output) {
      await client.send(new SendTaskSuccessCommand({ taskToken, output }));
    },
    async fail(taskToken, error, cause) {
      await client.send(new SendTaskFailureCommand({ taskToken, error, cause }));
    },
  };
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  err(`factory-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = WORKER_EXIT.error;
}
