// The role runner and the real ledger together, with a fake `query`: what a session emits is what the ledger stores.
import { tmpdir } from "node:os";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AttemptFailed, createRunner, loadRole, type QueryFn, type RunRole, type WorkItem } from "@vocab/factory-roles";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { closeAttempt, createWorkItem, listAttempts, openAttempt } from "../src/queries.ts";
import { LedgerRecorder } from "../src/recorder.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { assistant, init, result } from "./messages.ts";

const ROLE = "proposal-author";
const TOKENS = { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 };
const API_KEY = "api-key-value";
const GITHUB_TOKEN = "github-token-value";
const WORKER_HOME = "/home/worker-home-marker";

let db: TestDatabase;
let nextIssue = 1;

beforeAll(async () => {
  db = await createTestDatabase("runner");
  await migrate(db.pool);
  return () => db.close();
});

function saying(text: string): SDKMessage {
  const message = assistant(TOKENS);
  return { ...message, message: { ...message.message, content: [{ type: "text", text, citations: null }] } };
}

/**
 * Runs one attempt against the ledger. `steps` builds the session's messages from the options the
 * runner started it with. The result fails the role's schema, so the attempt ends before the
 * runner validates a change, which these tests do not need.
 */
async function attempt(env: Record<string, string>, authMode: "api-key" | "subscription", steps: (sessionEnv: Record<string, string | undefined>) => SDKMessage[]) {
  const issueNumber = nextIssue++;
  const row = await createWorkItem(db.pool, { issueNumber, changeId: `add-item-${String(issueNumber)}`, branch: `add-item-${String(issueNumber)}`, state: "proposal" });
  const opened = await openAttempt(db.pool, { workItemId: row.id, state: "proposal", role: ROLE });

  const query: QueryFn = ({ options }) =>
    (async function* () {
      for (const step of steps(options.env ?? {})) {
        await Promise.resolve();
        yield step;
      }
    })();
  const runRole: RunRole = createRunner({ query, recorder: new LedgerRecorder(db.pool), env });
  const item: WorkItem = { id: row.id, changeId: row.changeId, worktree: tmpdir(), issue: { title: "Add a sample", body: "Please add a sample." }, changeFiles: [], specs: [] };

  const error: unknown = await runRole({ ...(await loadRole(ROLE)), authMode }, item).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AttemptFailed)) throw new Error(`expected an AttemptFailed, got ${String(error)}`);
  await closeAttempt(db.pool, opened.id, { outcome: "failed", failureReason: error.reason });
  return { workItemId: row.id, error };
}

/** Every row of every ledger table, as text. */
async function ledgerDump(): Promise<string> {
  const rows: string[] = [];
  for (const table of ["work_items", "attempts", "messages", "events"]) {
    const { rows: found } = await db.pool.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM ${table} t`);
    rows.push(...found.map(({ row }) => row));
  }
  return rows.join("\n");
}

describe("the role runner with the ledger", () => {
  it("Scenario: Credentials stay out of the ledger", async () => {
    // The CLI process holds its own credential, but tools never expose it to the model (the read
    // guard, and no Bash). Anything else in the session's environment could reach a message, so
    // this session writes all of the rest into one.
    await attempt({ PATH: "/usr/bin", HOME: WORKER_HOME, ANTHROPIC_API_KEY: API_KEY, FACTORY_GITHUB_TOKEN: GITHUB_TOKEN }, "api-key", (sessionEnv) => {
      const reachable = Object.entries(sessionEnv).filter(([name]) => name !== "ANTHROPIC_API_KEY");
      return [init("ANTHROPIC_API_KEY"), saying(JSON.stringify(reachable)), result(TOKENS, 0.01)];
    });

    const dump = await ledgerDump();
    // Control: without it, a ledger that stored nothing would pass.
    expect(dump).toContain(WORKER_HOME);
    expect(dump).not.toContain(API_KEY);
    expect(dump).not.toContain(GITHUB_TOKEN);
  });

  it("Scenario: Deployment overrides the configured mode (the ledger records it)", async () => {
    const { workItemId, error } = await attempt({ PATH: "/usr/bin", FACTORY_AUTH_MODE: "api-key", ANTHROPIC_API_KEY: API_KEY }, "subscription", () => [
      init("ANTHROPIC_API_KEY"),
      result(TOKENS, 0.01),
    ]);

    // The empty result's failure, so the override got past the auth-mode check.
    expect(error.reason).toBe("invalid-result");
    expect((await listAttempts(db.pool, workItemId)).map((row) => row.authMode)).toEqual(["api-key"]);
  });
});
