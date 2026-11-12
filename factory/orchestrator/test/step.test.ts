// Step, the recording of build outcomes and the tick (add-build-loop task 3.7): a fake build runner
// writing outcomes to an FsStore, a fake classifier, the real local ledger and a temp remote.
import { listAttempts, listMessages, listTasks, workItemCost, type AttemptRow, type WorkItemRow } from "@vocab/factory-ledger";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../src/build-io.ts";
import { MAX_IMPLEMENTER_ATTEMPTS, MAX_INFRA_FAILURES, step, type StepContext, type StepResult } from "../src/step.ts";
import { buildTask as buildTaskOf, classified, CODE, currentWorkItem, SOURCE, TEST_FILE, TESTS, useBuildHarness, type Harness } from "./build-harness.ts";
import type { FakeBuildStep } from "./fake-build-runner.ts";
import type { FakeStep } from "./fake-role-runner.ts";
import { BOT, CHANGE, CHANGE_ID, changedFiles, git, identityOf, plannedWorkItem, remoteHead, subjectsSince, useWorkItemFixture } from "./work-item-fixture.ts";

const f = useWorkItemFixture("step");
const builds = useBuildHarness(f);

const RED_OUTPUT = "Error: Failed to load url ../src/lookups.ts (resolved id: ../src/lookups.ts). Does the file exist?";
const GREEN_OUTPUT = "AssertionError: expected [ 'cat' ] to deeply equal []";
const failedGreen = (output = GREEN_OUTPUT): FakeBuildStep => ({ ...CODE, outcome: "failed", reason: "green", output });

const BUG_EVIDENCE = "parseLookups returns the word list of the fixture instead of an empty list.";

function harness(steps: FakeBuildStep[], classifications: FakeStep[] = [], overrides: Partial<StepContext> = {}): Harness {
  return builds.create(steps, classifications, overrides);
}

const current = (): Promise<WorkItemRow> => currentWorkItem(f);
const buildTask = (h: Harness, taskId: string): Promise<StepResult[]> => buildTaskOf(f, h, taskId);

async function attemptsOf(workItem: WorkItemRow, role: string): Promise<AttemptRow[]> {
  return (await listAttempts(f.db.pool, workItem.id)).filter((attempt) => attempt.role === role);
}

describe("step", { timeout: 60_000 }, () => {
  it("Scenario: Tests are committed before code", async () => {
    const workItem = await plannedWorkItem(f);
    const planHead = remoteHead(f);
    const h = harness([TESTS]);

    // The first step writes the test author's input; the second records its outcome and writes the implementer's.
    expect(await step(h.ctx, await current(), "1.1")).toMatchObject({ kind: "build", afterWait: false });
    await h.build.runBuild({ changeId: CHANGE_ID, taskId: "1.1" });
    expect(await step(h.ctx, await current(), "1.1")).toMatchObject({ kind: "build", afterWait: false });
    expect(h.build.calls.map((call) => [call.next.role, call.next.mode])).toEqual([["test-author", "session"]]);
    expect(h.build.calls[0]?.input.baseCommit).toBe(planHead);

    // Its tests are one commit by the bot on the plan's commit, holding the test and the stub only.
    const testsCommit = remoteHead(f);
    expect(git(f.remote, "rev-parse", `${testsCommit}^`)).toBe(planHead);
    expect(changedFiles(f, testsCommit)).toEqual([SOURCE, TEST_FILE].sort());
    expect(subjectsSince(f, planHead)).toEqual([`test(${CHANGE_ID}): tests for task 1.1`]);
    expect(identityOf(f, testsCommit)).toBe(`${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`);

    // The implementer's input, written by the second step, names that commit as its base.
    h.build.script(CODE);
    await h.build.runBuild({ changeId: CHANGE_ID, taskId: "1.1" });
    expect(h.build.calls[1]?.next).toMatchObject({ role: "implementer", mode: "session" });
    expect(h.build.calls[1]?.input.baseCommit).toBe(testsCommit);
    expect(h.build.calls[1]?.input.task).toEqual(expect.objectContaining({ id: "1.1", title: "Parse the lookups" }));

    const [attempt] = await attemptsOf(workItem, "test-author");
    expect(attempt).toMatchObject({ state: "build", taskId: "1.1", outcome: "succeeded", gates: { mode: "red", passed: true } });
    expect(attempt?.storePrefix).toMatch(new RegExp(`^work-items/${CHANGE_ID}/tasks/1\\.1/test-author/`));
  });

  it("Scenario: Red gate failure retries the test author", async () => {
    const workItem = await plannedWorkItem(f);
    const planHead = remoteHead(f);
    const h = harness([{ ...TESTS, outcome: "failed", reason: "red", output: RED_OUTPUT }, TESTS, CODE]);

    const results = await buildTask(h, "1.1");

    expect(results.at(-1)?.kind).toBe("done");
    expect(h.build.calls.map((call) => call.next.role)).toEqual(["test-author", "test-author", "implementer"]);
    expect(h.build.calls[0]?.input.evidence).toBeUndefined();
    expect(h.build.calls[1]?.input.evidence?.reason).toBe("red");
    expect(h.build.calls[1]?.input.evidence?.evidence).toContain(RED_OUTPUT);
    // The failed attempt committed nothing: its retry starts from the plan's commit.
    expect(h.build.calls[1]?.input.baseCommit).toBe(planHead);
    expect((await attemptsOf(workItem, "test-author")).map((attempt) => [attempt.outcome, attempt.failureReason])).toEqual([
      ["failed", "red"],
      ["succeeded", null],
    ]);
  });

  it("Scenario: Forged patch is refused", async () => {
    const workItem = await plannedWorkItem(f);
    // The outcome claims a passed diff check and passed gates, but its patch changes package.json.
    const forged: FakeBuildStep = { files: { ...CODE.files, "package.json": '{ "name": "vocab", "scripts": { "test": "true" } }\n' } };
    const h = harness([TESTS, forged, CODE]);

    await step(h.ctx, await current(), "1.1");
    await h.build.runBuild({ changeId: CHANGE_ID, taskId: "1.1" });
    await step(h.ctx, await current(), "1.1");
    const testsCommit = remoteHead(f);
    await h.build.runBuild({ changeId: CHANGE_ID, taskId: "1.1" });
    const result = await step(h.ctx, await current(), "1.1");

    // Nothing from the forged patch is committed, and the task is not done.
    expect(remoteHead(f)).toBe(testsCommit);
    expect((await listTasks(f.db.pool, workItem.id)).find((task) => task.taskId === "1.1")?.status).toBe("pending");
    const [forgedAttempt] = await attemptsOf(workItem, "implementer");
    expect(forgedAttempt).toMatchObject({ outcome: "failed", failureReason: "diff-check" });
    // The next implementer attempt is told which path was refused; no classifier ran for it.
    expect(result).toMatchObject({ kind: "build", afterWait: false });
    await h.build.runBuild({ changeId: CHANGE_ID, taskId: "1.1" });
    expect(h.build.calls[2]?.next.role).toBe("implementer");
    expect(h.build.calls[2]?.input.evidence?.reason).toBe("diff-check");
    expect(h.build.calls[2]?.input.evidence?.evidence).toContain("package.json");
    expect(h.classifierCalls).toEqual([]);
  });

  it("Scenario: Bug is retried with evidence", async () => {
    const workItem = await plannedWorkItem(f);
    const h = harness([TESTS, failedGreen(), CODE], [classified("bug", BUG_EVIDENCE)]);

    const results = await buildTask(h, "1.1");

    expect(results.at(-1)?.kind).toBe("done");
    expect(h.build.calls.map((call) => call.next.role)).toEqual(["test-author", "implementer", "implementer"]);
    const evidence = h.build.calls[2]?.input.evidence;
    expect(evidence?.evidence).toContain(GREEN_OUTPUT);
    expect(evidence?.evidence).toContain(BUG_EVIDENCE);

    // The classifier saw the failed gates; its label is on the failed attempt.
    expect(h.classifierCalls.map((call) => call.role)).toEqual(["failure-classifier"]);
    expect(h.classifierCalls[0]?.item.prompt).toContain(GREEN_OUTPUT);
    const implementerAttempts = await attemptsOf(workItem, "implementer");
    expect(implementerAttempts[0]).toMatchObject({
      taskId: "1.1",
      outcome: "failed",
      failureReason: "green",
      classification: { kind: "bug", evidence: BUG_EVIDENCE },
      gates: { mode: "green", passed: false },
    });
    expect(await attemptsOf(workItem, "failure-classifier")).toEqual([expect.objectContaining({ state: "build", taskId: "1.1", outcome: "succeeded" })]);
  });

  it("Scenario: Three failed implementer attempts escalate", async () => {
    const workItem = await plannedWorkItem(f);
    const lastOutput = "AssertionError: expected [ 'dog' ] to deeply equal []";
    const h = harness([TESTS, failedGreen(), failedGreen(), failedGreen(lastOutput)], [classified("bug", BUG_EVIDENCE), classified("bug", BUG_EVIDENCE), classified("bug", BUG_EVIDENCE)]);
    const comments = f.forge.comments.length;

    const results = await buildTask(h, "1.1");

    expect(MAX_IMPLEMENTER_ATTEMPTS).toBe(3);
    expect(results.at(-1)).toMatchObject({ kind: "escalate", workItem: { state: "escalated" } });
    expect((await current()).state).toBe("escalated");
    expect(h.build.calls.filter((call) => call.next.role === "implementer")).toHaveLength(3);
    expect(f.forge.comments).toHaveLength(comments + 1);
    const body = f.forge.comments.at(-1)?.body ?? "";
    expect(body).toContain("1.1");
    expect(body).toContain("Parse the lookups");
    expect(body).toContain(lastOutput);
    expect((await listTasks(f.db.pool, workItem.id)).find((task) => task.taskId === "1.1")?.status).toBe("pending");
  });

  it("Scenario: Spec ambiguity goes to the owner", async () => {
    await plannedWorkItem(f);
    const question = "The spec does not say whether a lookup without a book is imported or skipped.";
    const h = harness([TESTS, failedGreen()], [classified("spec-ambiguity", question)]);
    const comments = f.forge.comments.length;

    const results = await buildTask(h, "1.1");

    expect(results.at(-1)).toMatchObject({ kind: "escalate", workItem: { state: "escalated" } });
    expect(f.forge.comments).toHaveLength(comments + 1);
    const body = f.forge.comments.at(-1)?.body ?? "";
    expect(body).toContain(question);
    expect(body).toMatch(/question/i);
  });

  it("Scenario: Infrastructure failure waits and retries", async () => {
    await plannedWorkItem(f);
    const infra = "The vitest worker was killed with SIGKILL: out of memory.";
    const h = harness([TESTS, failedGreen(), failedGreen(), failedGreen()], [classified("infra", infra), classified("infra", infra), classified("infra", infra)]);
    const comments = f.forge.comments.length;

    const results = await buildTask(h, "1.1");

    expect(MAX_INFRA_FAILURES).toBe(3);
    // The tests and the first implementer build need no wait; the two retries after infra do.
    expect(results.map((result) => (result.kind === "build" ? `build${result.afterWait ? " after wait" : ""}` : result.kind))).toEqual([
      "build",
      "build",
      "build after wait",
      "build after wait",
      "escalate",
    ]);
    expect((await current()).state).toBe("escalated");
    expect(f.forge.comments).toHaveLength(comments + 1);
    const body = f.forge.comments.at(-1)?.body ?? "";
    expect(body).toMatch(/infrastructure/i);
    expect(body).toContain(infra);
  });

  it("Scenario: Flaky failure re-runs the gates only", async () => {
    const workItem = await plannedWorkItem(f);
    // The gates-only build applies the earlier patch; its own files are ignored.
    const h = harness([TESTS, failedGreen(), {}], [classified("flaky", "The test timed out once under load; the code is right.")]);

    const results = await buildTask(h, "1.1");

    expect(results.at(-1)?.kind).toBe("done");
    expect(h.build.calls.map((call) => [call.next.role, call.next.mode])).toEqual([
      ["test-author", "session"],
      ["implementer", "session"],
      ["implementer", "gates-only"],
    ]);
    const [session] = await attemptsOf(workItem, "implementer");
    expect(h.build.calls[2]?.next.patch).toBe(`${session?.storePrefix ?? ""}/patch.diff`);
    expect(h.build.calls[2]?.input.baseCommit).toBe(h.build.calls[1]?.input.baseCommit);
    // Only the two sessions recorded messages: the re-run had no session.
    const withMessages = [];
    for (const attempt of await listAttempts(f.db.pool, workItem.id)) {
      if (attempt.taskId === "1.1" && attempt.role !== "failure-classifier" && (await listMessages(f.db.pool, attempt.id)).length > 0) withMessages.push(attempt.role);
    }
    expect(withMessages).toEqual(["test-author", "implementer"]);
    // The re-run's pass ticks the task with the first session's code.
    expect(git(f.remote, "show", `${remoteHead(f)}:${SOURCE}`)).toBe((CODE.files?.[SOURCE] ?? "").trimEnd());
  });

  it("Scenario: Task is ticked with its code", async () => {
    const workItem = await plannedWorkItem(f);
    const h = harness([TESTS, CODE]);

    const results = await buildTask(h, "1.1");

    expect(results.map((result) => result.kind)).toEqual(["build", "build", "done"]);
    const head = remoteHead(f);
    const testsCommit = git(f.remote, "rev-parse", `${head}^`);
    expect(subjectsSince(f, testsCommit)).toEqual([`feat(${CHANGE_ID}): task 1.1 Parse the lookups`]);
    expect(changedFiles(f, head)).toEqual([SOURCE, `${CHANGE}/tasks.md`].sort());
    expect(identityOf(f, head)).toBe(`${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`);
    const tasksMd = git(f.remote, "show", `${head}:${CHANGE}/tasks.md`);
    expect(tasksMd).toContain("- [x] 1.1 Parse the lookups");
    expect(tasksMd).toContain("- [ ] 1.2 Parse the books");
    expect(git(f.remote, "show", `${head}:${SOURCE}`)).toBe((CODE.files?.[SOURCE] ?? "").trimEnd());

    const tasks = await listTasks(f.db.pool, workItem.id);
    expect(tasks.map((task) => [task.taskId, task.status, task.doneCommit])).toEqual([
      ["1.1", "done", head],
      ["1.2", "pending", null],
    ]);
    // The green gates of task 1.1 cover its own scenarios.
    expect(h.build.calls[1]?.input.coveredSoFar).toEqual(["Lookups are imported"]);
  });

  it("Scenario: Ticked task is not rebuilt", async () => {
    const workItem = await plannedWorkItem(f);
    const h = harness([TESTS, CODE]);
    await buildTask(h, "1.1");
    const head = remoteHead(f);
    const attempts = (await listAttempts(f.db.pool, workItem.id)).length;
    const calls = h.build.calls.length;

    const result = await step(h.ctx, await current(), "1.1");

    expect(result).toMatchObject({ kind: "done" });
    expect(h.build.calls).toHaveLength(calls);
    expect(h.classifierCalls).toEqual([]);
    expect((await listAttempts(f.db.pool, workItem.id)).length).toBe(attempts);
    expect(remoteHead(f)).toBe(head);
  });

  it("Scenario: Build cost reaches the ledger", async () => {
    const workItem = await plannedWorkItem(f);
    const h = harness([TESTS, { ...CODE, costUsd: 0.75 }]);

    await buildTask(h, "1.1");

    const [attempt] = await attemptsOf(workItem, "implementer");
    expect(attempt).toMatchObject({ outcome: "succeeded", authMode: "subscription", costUsdEstimate: 0.75 });
    const messages = await listMessages(f.db.pool, attempt?.id ?? "");
    expect(messages.map((message) => message.type)).toEqual(["system", "result"]);
    expect(messages[1]).toMatchObject({ inputTokens: 2000, outputTokens: 800, cacheReadTokens: 100, cacheCreationTokens: 50 });
    const all = await listAttempts(f.db.pool, workItem.id);
    const total = all.reduce((sum, row) => sum + (row.costUsdEstimate ?? 0), 0);
    expect(await workItemCost(f.db.pool, workItem.id)).toBeCloseTo(total, 6);
    expect(total).toBeGreaterThanOrEqual(0.75 + 0.4);
  });

  it("records a build with no outcome as no-outcome and counts it as infra", async () => {
    const workItem = await plannedWorkItem(f);
    const h = harness([{ noOutcome: true }, TESTS, CODE]);

    const results = await buildTask(h, "1.1");

    expect(results.map((result) => (result.kind === "build" ? `build${result.afterWait ? " after wait" : ""}` : result.kind))).toEqual([
      "build",
      "build after wait",
      "build",
      "done",
    ]);
    const [lost] = await attemptsOf(workItem, "test-author");
    expect(lost).toMatchObject({ outcome: "failed", failureReason: "no-outcome", classification: { kind: "infra" } });
    expect(h.build.calls.map((call) => call.next.role)).toEqual(["test-author", "test-author", "implementer"]);
  });

  it("records an outcome once when step is repeated after recording it", async () => {
    const workItem = await plannedWorkItem(f);
    const planHead = remoteHead(f);
    // The step that records the tests crashes writing the implementer's input; the repeat must not record them again.
    let failNext = true;
    const flaky: ArtifactStore = {
      get: (key) => builds.store().get(key),
      exists: (key) => builds.store().exists(key),
      put: (key, body) => {
        if (failNext && key.includes("/implementer/")) {
          failNext = false;
          return Promise.reject(new Error("store unavailable"));
        }
        return builds.store().put(key, body);
      },
    };
    const h = harness([TESTS], [], { store: flaky });

    await step(h.ctx, await current(), "1.1");
    await h.build.runBuild({ changeId: CHANGE_ID, taskId: "1.1" });
    await expect(step(h.ctx, await current(), "1.1")).rejects.toThrow(/store unavailable/);
    const [testAttempt] = await attemptsOf(workItem, "test-author");
    const messages = (await listMessages(f.db.pool, testAttempt?.id ?? "")).length;

    const result = await step(h.ctx, await current(), "1.1");

    expect(result).toMatchObject({ kind: "build", afterWait: false });
    expect(subjectsSince(f, planHead)).toEqual([`test(${CHANGE_ID}): tests for task 1.1`]);
    expect(await attemptsOf(workItem, "test-author")).toEqual([expect.objectContaining({ outcome: "succeeded" })]);
    expect((await listMessages(f.db.pool, testAttempt?.id ?? "")).length).toBe(messages);
    // The implementer's input is written once, for an attempt that is still to run.
    expect((await attemptsOf(workItem, "implementer")).map((attempt) => attempt.outcome)).toEqual([null]);
  });
});
