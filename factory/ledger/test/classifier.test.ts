// The failure classifier with the real ledger and a fake `query` (add-build-roles task 2.8).
import { tmpdir } from "node:os";
import { createRunner, loadRole, renderClassifierPrompt, type ClassifierInput, type QueryFn, type WorkItem } from "@vocab/factory-roles";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { closeAttempt, createWorkItem, listAttempts, listAttemptUsage, openAttempt } from "../src/queries.ts";
import { LedgerRecorder } from "../src/recorder.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { assistant, init, result } from "./messages.ts";

const ROLE = "failure-classifier";
const TOKENS = { input: 1200, output: 80, cacheRead: 0, cacheCreation: 0 };

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase("classifier");
  await migrate(db.pool);
  return () => db.close();
});

const gates: ClassifierInput["gates"] = {
  mode: "green",
  changeId: "add-sample",
  taskId: "1.1",
  passed: false,
  checks: [
    {
      name: "unit",
      passed: false,
      exitCode: 1,
      durationMs: 1200,
      output: "FAIL app/domain/test/word.test.ts > Scenario: Words are counted\nAssertionError: expected 1 to be 2\n",
      tests: [{ file: "app/domain/test/word.test.ts", name: "Scenario: Words are counted", problem: "failed" }],
    },
  ],
};

describe("the failure classifier with the ledger", () => {
  it("Scenario: Classifier labels a failed gate", async () => {
    const row = await createWorkItem(db.pool, { issueNumber: 1, changeId: "add-sample", branch: "add-sample", state: "build" });
    const opened = await openAttempt(db.pool, { workItemId: row.id, state: "build", role: ROLE });
    const label = { kind: "bug", evidence: "The task's own test fails on an assertion: expected 1 to be 2." };
    const query: QueryFn = () =>
      (async function* () {
        await Promise.resolve();
        yield init("none");
        yield assistant(TOKENS);
        yield { ...result(TOKENS, 0.0021), structured_output: label };
      })();
    const prompt = renderClassifierPrompt({
      changeId: "add-sample",
      task: { id: "1.1", title: "Count the words", scenarios: ["Words are counted"] },
      gates,
      changedPaths: ["app/domain/src/word.ts"],
    });
    const item: WorkItem = { id: row.id, changeId: row.changeId, worktree: tmpdir(), issue: { title: "", body: "" }, changeFiles: [], specs: [], prompt };

    const runRole = createRunner({ query, recorder: new LedgerRecorder(db.pool), env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" } });
    const classified = await runRole(await loadRole(ROLE), item);
    await closeAttempt(db.pool, opened.id, { outcome: "succeeded" });

    expect(classified).toEqual(label);
    const attempts = await listAttempts(db.pool, row.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ role: ROLE, outcome: "succeeded", authMode: "subscription", costUsdEstimate: 0.0021 });
    expect(await listAttemptUsage(db.pool, row.id)).toEqual([{ attemptId: opened.id, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheCreationTokens: 0 }]);
  });
});
