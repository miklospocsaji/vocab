/**
 * Live design-reviewer run (add-build-roles task 2.13): the real role (Sonnet, worker, read-only),
 * capped at $0.50 in api-key mode, on the fixture change `add-lookup-counts` with a design that
 * contradicts its delta spec: the spec counts "The" and "the" together, the design keys counts by
 * the exact word. The expected verdict is `changes-requested`. The findings, the turns and the
 * cost are printed for the task's record.
 */
import { ReviewResult } from "@vocab/factory-artifacts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRole, type Role } from "../src/config.ts";
import { createCostLog, outcomeOf, runProbe, toolCalls, type LiveAttempt } from "./live-harness.ts";
import { apiKeyEnv, capped, CHANGE_ID, ISSUE, LIVE_CAP_USD, makeChangeRepo, report, type ChangeRepo } from "./live-change.ts";

let repo: ChangeRepo;
let role: Role;
let attempt: LiveAttempt;
const costs = createCostLog();

beforeAll(async () => {
  const env = apiKeyEnv();
  repo = makeChangeRepo("design-contradiction.md");
  role = capped(await loadRole("design-reviewer"));
  attempt = await runProbe(role, repo.root, { env, changeId: CHANGE_ID, issue: ISSUE, changeFiles: repo.changeFiles(), specs: repo.specs() });
  costs.track("design-reviewer (planted contradiction)", attempt);
  report("design-reviewer", attempt);
}, 900_000);

afterAll(() => {
  costs.print();
  repo.remove();
});

describe("live design reviewer", () => {
  it("returns a result that parses, requesting changes for the planted contradiction", () => {
    expect(outcomeOf(attempt)).toBe("succeeded");
    const review = ReviewResult.parse(attempt.outcome);
    expect(review.verdict).toBe("changes-requested");
    // The schema already demands a blocker or major finding; one of them must be about case.
    const serious = review.findings.filter((finding) => finding.severity !== "minor");
    expect(serious.some((finding) => /case|"The"|lower/i.test(`${finding.location} ${finding.summary}`)), JSON.stringify(serious)).toBe(true);
  });

  it("only reads", () => {
    expect(toolCalls(attempt.messages).filter((call) => !["Read", "Grep", "Glob"].includes(call.name) && !/structured/i.test(call.name))).toEqual([]);
    expect(repo.changedPaths()).toEqual([]);
  });

  it("stays under the live cap in api-key mode", () => {
    expect(attempt.result?.total_cost_usd ?? 0).toBeLessThan(LIVE_CAP_USD);
    expect(attempt.sent?.options.env?.["ANTHROPIC_API_KEY"]).toBeDefined();
  });
});
