/**
 * Live failure-classifier run (add-build-roles task 2.13): the real role (Haiku, no tools, its own
 * $0.05 cap) in api-key mode, on a fixture green-gate failure: the unit check failed on an
 * assertion in the task's own test, while the implementation ignores case. The session's turn
 * count is printed so `maxTurns` in failure-classifier.yaml can be set from it (task 2.8).
 */
import { ClassificationResult, type GatesResult } from "@vocab/factory-artifacts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderClassifierPrompt } from "../src/classifier.ts";
import { loadRole, type Role } from "../src/config.ts";
import { createCostLog, makeWorktree, outcomeOf, removeDir, runProbe, toolCalls, type LiveAttempt } from "./live-harness.ts";
import { apiKeyEnv, capped, CHANGE_ID, LIVE_CAP_USD, report, SCENARIOS } from "./live-change.ts";

const TEST_FILE = "app/domain/test/lookup-counts.test.ts";
const OUTPUT = `FAIL  ${TEST_FILE} > Scenario: Words differing only in case are counted together
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ ${TEST_FILE}:18:38
     16|   it("Scenario: Words differing only in case are counted together", () => {
     17|     const counts = countLookups([lookup("The"), lookup("the")]);
     18|     expect(counts.get("the")).toBe(2);
       |                               ^
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
`;

const GATES: GatesResult = {
  mode: "green",
  changeId: CHANGE_ID,
  taskId: "1.1",
  passed: false,
  checks: [
    { name: "typecheck", passed: true, exitCode: 0, durationMs: 2100, output: "" },
    { name: "lint", passed: true, exitCode: 0, durationMs: 1800, output: "" },
    {
      name: "unit",
      passed: false,
      exitCode: 1,
      durationMs: 950,
      output: OUTPUT,
      tests: [{ file: TEST_FILE, name: "Scenario: Words differing only in case are counted together", problem: "failed" }],
    },
  ],
};

let worktree: string;
let role: Role;
let attempt: LiveAttempt;
const costs = createCostLog();

beforeAll(async () => {
  const env = apiKeyEnv();
  worktree = makeWorktree();
  role = capped(await loadRole("failure-classifier"));
  const prompt = renderClassifierPrompt({
    changeId: CHANGE_ID,
    task: { id: "1.1", title: "Count lookups per word", scenarios: SCENARIOS },
    gates: GATES,
    changedPaths: ["app/domain/src/lookup-counts.ts"],
  });
  attempt = await runProbe(role, worktree, { env, changeId: CHANGE_ID, prompt });
  costs.track("failure-classifier", attempt);
  report("failure-classifier", attempt, { maxTurns: role.maxTurns });
}, 300_000);

afterAll(() => {
  costs.print();
  removeDir(worktree);
});

describe("live failure classifier", () => {
  it("labels a fixture gate failure, recording how many turns it took", () => {
    expect(outcomeOf(attempt)).toBe("succeeded");
    const result = ClassificationResult.parse(attempt.outcome);
    // A failed assertion in the task's own test, with nothing outside the change involved.
    expect(result.kind).toBe("bug");
    const turns = attempt.result?.num_turns;
    expect(turns, "the result has no turn count").toBeTypeOf("number");
    expect(turns).toBeLessThanOrEqual(role.maxTurns);
    console.log(`failure-classifier turns: ${String(turns)} (maxTurns ${String(role.maxTurns)})`);
  });

  it("makes no tool call but the structured output", () => {
    expect(toolCalls(attempt.messages).filter((call) => !/structured/i.test(call.name))).toEqual([]);
  });

  it("stays under the live cap in api-key mode", () => {
    expect(attempt.result?.total_cost_usd ?? 0).toBeLessThan(LIVE_CAP_USD);
    expect(attempt.sent?.options.env?.["ANTHROPIC_API_KEY"]).toBeDefined();
  });
});
