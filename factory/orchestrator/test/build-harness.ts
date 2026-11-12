/**
 * Test helper for the build loop: a `StepContext` on the work-item fixture with an FsStore, the
 * build roles and a fake classifier, a fake build runner on the same store, and a driver that
 * steps a task and runs the builds it asks for. Shared build steps for task 1.1 of `PLAN`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkItemByIssue, LedgerRecorder, type WorkItemRow } from "@vocab/factory-ledger";
import { loadRole, type Role } from "@vocab/factory-roles";
import { afterEach, beforeAll, beforeEach } from "vitest";
import { FsStore } from "../../worker/src/store.ts";
import type { ArtifactStore } from "../src/build-io.ts";
import { step, type StepContext, type StepResult } from "../src/step.ts";
import { createFakeBuildRunner, type FakeBuildRunner, type FakeBuildStep } from "./fake-build-runner.ts";
import { createFakeRoleRunner, type FakeCall, type FakeStep } from "./fake-role-runner.ts";
import { BOT, CHANGE_ID, ISSUE, type Fixture } from "./work-item-fixture.ts";

export const TEST_FILE = "app/domain/test/lookups.test.ts";
export const SOURCE = "app/domain/src/lookups.ts";

/** Test author's build of a task: its test file and the stub of its new source file. */
export const testsFor = (test: string, source: string, scenario: string): FakeBuildStep => ({
  files: {
    [test]: `import { expect, it } from "vitest";\nimport { run } from "../src/${source.split("/").at(-1) ?? ""}";\n\nit("Scenario: ${scenario}", () => {\n  expect(run()).toEqual([]);\n});\n`,
    [source]: 'export function run(): never {\n  throw new Error("not implemented");\n}\n',
  },
});
/** Implementer's build of a task: its source file. */
export const codeFor = (source: string): FakeBuildStep => ({ files: { [source]: "export function run(): string[] {\n  return [];\n}\n" } });

export const TESTS = testsFor(TEST_FILE, SOURCE, "Lookups are imported");
export const CODE = codeFor(SOURCE);

export const classified = (kind: string, evidence: string): FakeStep => ({ result: { kind, evidence } });

export interface Harness {
  ctx: StepContext;
  build: FakeBuildRunner;
  /** The classifier's calls. */
  classifierCalls: FakeCall[];
}

export interface BuildHarness {
  /** The FsStore of the current test. */
  store(): ArtifactStore;
  create(builds: FakeBuildStep[], classifications?: FakeStep[], overrides?: Partial<StepContext>): Harness;
}

/** Registers the hooks; call it after `useWorkItemFixture`. */
export function useBuildHarness(f: Fixture): BuildHarness {
  let classifier: Role;
  let testAuthor: Role;
  let implementer: Role;
  let root: string;
  let store: ArtifactStore;

  beforeAll(async () => {
    classifier = await loadRole("failure-classifier");
    testAuthor = await loadRole("test-author");
    implementer = await loadRole("implementer");
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "factory-build-store-"));
    store = new FsStore(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return {
    store: () => store,
    create(builds, classifications = [], overrides = {}) {
      const fake = createFakeRoleRunner(new LedgerRecorder(f.db.pool), classifications);
      const ctx: StepContext = {
        db: f.db.pool,
        forge: f.forge,
        runRole: fake.runRole,
        classifier,
        testAuthor,
        implementer,
        store,
        cloneUrl: f.remote,
        repo: f.repo,
        home: f.home,
        committer: BOT,
        ...overrides,
      };
      return { ctx, build: createFakeBuildRunner(overrides.store ?? store, builds), classifierCalls: fake.calls };
    },
  };
}

export async function currentWorkItem(f: Fixture): Promise<WorkItemRow> {
  const workItem = await findWorkItemByIssue(f.db.pool, ISSUE.number);
  if (workItem === undefined) throw new Error("no work item");
  return workItem;
}

/** Step, then the build it asks for, until a step asks for none; at most `limit` steps. */
export async function buildTask(f: Fixture, h: Harness, taskId: string, limit = 12): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (let i = 0; i < limit; i += 1) {
    const result = await step(h.ctx, await currentWorkItem(f), taskId);
    results.push(result);
    if (result.kind !== "build") return results;
    await h.build.runBuild({ changeId: CHANGE_ID, taskId });
  }
  throw new Error(`task ${taskId} took more than ${String(limit)} steps`);
}
