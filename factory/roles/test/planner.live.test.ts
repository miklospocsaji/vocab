/**
 * Live planner run (add-build-roles task 2.13): the real role (Sonnet, worker, no Bash), capped at
 * $0.50 in api-key mode, on the fixture change `add-lookup-counts` with its proposal, delta spec
 * and a consistent design. The plan must pass `validatePlan` against the implementer's and the
 * test author's real globs. `tasks.md`, the plan, the turns and the cost are printed for the
 * task's record.
 */
import { join } from "node:path";
import { PlanResult } from "@vocab/factory-artifacts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRole, type Role } from "../src/config.ts";
import { validatePlan } from "../src/plan.ts";
import { createCostLog, outcomeOf, runProbe, type LiveAttempt } from "./live-harness.ts";
import { apiKeyEnv, capped, CHANGE, CHANGE_ID, ISSUE, LIVE_CAP_USD, makeChangeRepo, readIfExists, report, SCENARIOS, type ChangeRepo } from "./live-change.ts";

let repo: ChangeRepo;
let role: Role;
let attempt: LiveAttempt;
let tasksMd: string | undefined;
const costs = createCostLog();

beforeAll(async () => {
  const env = apiKeyEnv();
  repo = makeChangeRepo("design.md");
  role = capped(await loadRole("planner"));
  attempt = await runProbe(role, repo.root, { env, changeId: CHANGE_ID, issue: ISSUE, changeFiles: repo.changeFiles(), specs: repo.specs() });
  costs.track("planner", attempt);
  tasksMd = readIfExists(repo.root, `${CHANGE}/tasks.md`);
  report("planner", attempt, { "tasks.md": tasksMd ?? "(none)" });
}, 900_000);

afterAll(() => {
  costs.print();
  repo.remove();
});

describe("live planner", () => {
  it("returns a plan that passes validatePlan", async () => {
    expect(outcomeOf(attempt)).toBe("succeeded");
    const plan = PlanResult.parse(attempt.outcome);
    expect(tasksMd, "no tasks.md").toBeDefined();

    const [implementer, testAuthor] = await Promise.all([loadRole("implementer"), loadRole("test-author")]);
    const problems = await validatePlan(plan, join(repo.root, CHANGE), tasksMd ?? "", undefined, {
      implementer: implementer.writable,
      testAuthor: testAuthor.writable,
    });
    expect(problems).toEqual([]);
    // validatePlan already requires every scenario; this names the fixture's two for the reader.
    expect(plan.tasks.flatMap((task) => task.scenarios).sort()).toEqual([...SCENARIOS].sort());
  });

  it("writes only tasks.md", () => {
    expect(repo.changedPaths()).toEqual([`${CHANGE}/tasks.md`]);
  });

  it("stays under the live cap in api-key mode", () => {
    expect(attempt.result?.total_cost_usd ?? 0).toBeLessThan(LIVE_CAP_USD);
    expect(attempt.sent?.options.env?.["ANTHROPIC_API_KEY"]).toBeDefined();
  });
});
