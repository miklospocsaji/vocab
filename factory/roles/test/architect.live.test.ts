/**
 * Live architect run (add-build-roles task 2.13): the real role (Opus, worker, no Bash), capped
 * at $0.50 in api-key mode, on the fixture change `add-lookup-counts` with only its proposal and
 * delta spec. One attempt, no retry. The design, the result, the turns and the cost are printed
 * for the task's record.
 */
import { execFileSync } from "node:child_process";
import { DesignResult } from "@vocab/factory-artifacts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRole, type Role } from "../src/config.ts";
import { isWritable } from "../src/guard.ts";
import { createCostLog, outcomeOf, runProbe, type LiveAttempt } from "./live-harness.ts";
import { apiKeyEnv, capped, CHANGE, CHANGE_ID, ISSUE, LIVE_CAP_USD, makeChangeRepo, OPENSPEC, readIfExists, report, type ChangeRepo } from "./live-change.ts";

let repo: ChangeRepo;
let role: Role;
let attempt: LiveAttempt;
const costs = createCostLog();

beforeAll(async () => {
  const env = apiKeyEnv();
  repo = makeChangeRepo("none");
  role = capped(await loadRole("architect"));
  attempt = await runProbe(role, repo.root, { env, changeId: CHANGE_ID, issue: ISSUE, changeFiles: repo.changeFiles(), specs: repo.specs() });
  costs.track("architect", attempt);
  report("architect", attempt, { changed: repo.changedPaths(), "design.md": readIfExists(repo.root, `${CHANGE}/design.md`) ?? "(none)" });
}, 900_000);

afterAll(() => {
  costs.print();
  repo.remove();
});

describe("live architect", () => {
  it("Scenario: Architect output is complete", () => {
    // The runner returns a result only after the zod parse and `openspec validate --strict` passed.
    expect(outcomeOf(attempt)).toBe("succeeded");
    const result = DesignResult.parse(attempt.outcome);
    expect(readIfExists(repo.root, `${CHANGE}/design.md`), "no design.md").toBeDefined();

    // Strict validation again, so the test does not rest on the runner alone.
    execFileSync(OPENSPEC, ["validate", CHANGE_ID, "--strict", "--no-interactive"], { cwd: repo.root, env: { ...process.env, OPENSPEC_TELEMETRY: "0" } });

    // Only design.md and contracts changed, and the result lists the contracts it touched.
    const writable = [`${CHANGE}/design.md`, "app/contracts/src/**"];
    const changed = repo.changedPaths();
    expect(changed.filter((path) => !isWritable(path, writable))).toEqual([]);
    const contracts = changed.filter((path) => path.startsWith("app/contracts/src/"));
    for (const path of contracts) expect(result.contracts.some((listed) => listed.endsWith(path) || path.endsWith(listed)), path).toBe(true);
  });

  it("stays under the live cap in api-key mode", () => {
    expect(attempt.result?.total_cost_usd ?? 0).toBeLessThan(LIVE_CAP_USD);
    // The runner aborts an api-key run whose session reports another key source, so a success is api-key.
    expect(outcomeOf(attempt)).not.toBe("auth-mode-mismatch");
    expect(attempt.sent?.options.env?.["ANTHROPIC_API_KEY"]).toBeDefined();
    expect(attempt.sent?.options.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
  });
});
