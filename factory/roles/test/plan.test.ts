import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanResult } from "@vocab/factory-artifacts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePlan, type PlanPaths } from "../src/plan.ts";

// The implementer's and test author's globs as add-build-roles design.md gives them.
const PATHS: PlanPaths = {
  implementer: ["app/*/src/**", "!app/contracts/**", "infra/app-stack.ts", "infra/preview-stack.ts", "infra/app/**"],
  testAuthor: ["app/*/test/**", "app/e2e/**", "{taskStubs}"],
};

const SCENARIOS = ["Import reads every word", "Import reads every book", "Re-import adds only new lookups"];

let changeDir: string;

function spec(capability: string, titles: string[]): void {
  mkdirSync(join(changeDir, "specs", capability), { recursive: true });
  const body = titles.map((title) => `#### Scenario: ${title}\n- **WHEN** something\n- **THEN** something else\n`).join("\n");
  writeFileSync(join(changeDir, "specs", capability, "spec.md"), `## ADDED Requirements\n\n### Requirement: Import\nThe importer SHALL import.\n\n${body}`);
}

type Task = PlanResult["tasks"][number];

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    dependsOn: [],
    files: [`app/domain/src/task-${id.replace(".", "-")}.ts`],
    scenarios: [],
    tests: [`app/domain/test/task-${id.replace(".", "-")}.test.ts`],
    ...overrides,
  };
}

/** A plan of three tasks covering every scenario, 1.2 and 1.3 depending on earlier tasks. */
function goodPlan(): PlanResult {
  return {
    tasks: [
      task("1.1", { scenarios: [SCENARIOS[0] ?? ""] }),
      task("1.2", { scenarios: [SCENARIOS[1] ?? ""], dependsOn: ["1.1"] }),
      task("1.3", { scenarios: [SCENARIOS[2] ?? ""], dependsOn: ["1.1", "1.2"] }),
    ],
  };
}

function tasksMd(lines: string[]): string {
  return ["# Tasks", "", "## 1. Importer", "", ...lines, ""].join("\n");
}

const UNTICKED = tasksMd(["- [ ] 1.1 Parse the WORDS table", "- [ ] 1.2 Parse the BOOK_INFO table", "- [ ] 1.3 Re-import only new lookups"]);

beforeEach(() => {
  changeDir = mkdtempSync(join(tmpdir(), "vocab-plan-"));
  spec("vocab-import", SCENARIOS);
});

afterEach(() => {
  rmSync(changeDir, { recursive: true, force: true });
});

describe("validatePlan", () => {
  // Control: without it, a validatePlan that refuses everything would pass the scenarios below.
  it("accepts a plan that covers every scenario with tasks.md lines and allowed paths", async () => {
    expect(await validatePlan(goodPlan(), changeDir, UNTICKED, undefined, PATHS)).toEqual([]);
  });

  it("finds scenarios in every delta spec of the change", async () => {
    spec("roles", ["Planner writes the task list"]);
    const plan = goodPlan();
    plan.tasks.push(task("1.4", { scenarios: ["Planner writes the task list"] }));
    const md = tasksMd(["- [ ] 1.1 a", "- [ ] 1.2 b", "- [ ] 1.3 c", "- [ ] 1.4 d"]);
    expect(await validatePlan(plan, changeDir, md, undefined, PATHS)).toEqual([]);
  });

  it("Scenario: Plan that leaves a scenario out is refused", async () => {
    const plan = goodPlan();
    plan.tasks[2] = task("1.3", { dependsOn: ["1.1", "1.2"] });

    const problems = await validatePlan(plan, changeDir, UNTICKED, undefined, PATHS);
    expect(problems).toHaveLength(1);
    expect(problems.join("\n")).toContain("Re-import adds only new lookups");
  });

  it("Scenario: Re-plan keeps finished tasks", async () => {
    const previous = tasksMd(["- [x] 1.1 Parse the WORDS table", "- [x] 1.2 Parse the BOOK_INFO table", "- [ ] 1.3 Re-import only new lookups"]);

    // Control: a re-plan that keeps 1.1 and 1.2 as they were, and rewrites the unfinished 1.3, passes.
    const kept = tasksMd(["- [x] 1.1 Parse the WORDS table", "- [x] 1.2 Parse the BOOK_INFO table", "- [ ] 1.3 Re-import only new lookups, by timestamp"]);
    expect(await validatePlan(goodPlan(), changeDir, kept, previous, PATHS)).toEqual([]);

    const unticked = tasksMd(["- [x] 1.1 Parse the WORDS table", "- [ ] 1.2 Parse the BOOK_INFO table", "- [ ] 1.3 Re-import only new lookups"]);
    const rewritten = tasksMd(["- [x] 1.1 Parse the WORDS table", "- [x] 1.2 Parse the books", "- [ ] 1.3 Re-import only new lookups"]);
    const removed = tasksMd(["- [x] 1.1 Parse the WORDS table", "- [ ] 1.3 Re-import only new lookups"]);
    for (const md of [unticked, rewritten, removed]) {
      const problems = await validatePlan(goodPlan(), changeDir, md, previous, PATHS);
      expect(problems.length, md).toBeGreaterThan(0);
      expect(problems.join("\n"), md).toMatch(/\b1\.2\b/);
      expect(problems.join("\n"), md).not.toMatch(/\b1\.1\b/);
    }
  });

  it("Scenario: Plan with a forward dependency is refused", async () => {
    const plan = goodPlan();
    plan.tasks[0] = task("1.1", { scenarios: [SCENARIOS[0] ?? ""], dependsOn: ["1.2"] });

    const problems = await validatePlan(plan, changeDir, UNTICKED, undefined, PATHS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/\b1\.1\b/);
    expect(problems[0]).toMatch(/\b1\.2\b/);
  });

  it("refuses a task that depends on itself or on a task the plan does not have", async () => {
    const plan = goodPlan();
    plan.tasks[1] = task("1.2", { scenarios: [SCENARIOS[1] ?? ""], dependsOn: ["1.2"] });
    plan.tasks[2] = task("1.3", { scenarios: [SCENARIOS[2] ?? ""], dependsOn: ["9.9"] });

    const problems = await validatePlan(plan, changeDir, UNTICKED, undefined, PATHS);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/\b1\.2\b/);
    expect(problems.join("\n")).toMatch(/\b9\.9\b/);
  });

  it("refuses a task id with no tasks.md line, naming it", async () => {
    const md = tasksMd(["- [ ] 1.1 Parse the WORDS table", "- [ ] 1.3 Re-import only new lookups", "1.2 is mentioned but not a task line"]);
    const problems = await validatePlan(goodPlan(), changeDir, md, undefined, PATHS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/\b1\.2\b/);
    expect(problems[0]).toContain("tasks.md");
  });

  it("refuses an unknown scenario title, naming it", async () => {
    const plan = goodPlan();
    plan.tasks[0] = task("1.1", { scenarios: [SCENARIOS[0] ?? "", "Import reads every bookmark"] });

    const problems = await validatePlan(plan, changeDir, UNTICKED, undefined, PATHS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Import reads every bookmark");
  });

  it("refuses a file outside the implementer's paths and a test outside the test author's, naming each", async () => {
    const plan = goodPlan();
    plan.tasks[0] = task("1.1", {
      scenarios: [SCENARIOS[0] ?? ""],
      files: ["app/domain/src/import.ts", "app/contracts/src/import.ts", "factory/roles/src/runner.ts"],
      tests: ["app/domain/test/import.test.ts", "app/domain/src/import.test.ts"],
    });

    const problems = await validatePlan(plan, changeDir, UNTICKED, undefined, PATHS);
    expect(problems).toHaveLength(3);
    for (const path of ["app/contracts/src/import.ts", "factory/roles/src/runner.ts", "app/domain/src/import.test.ts"]) {
      expect(problems.filter((problem) => problem.includes(path)), path).toHaveLength(1);
    }
    expect(problems.join("\n")).not.toContain("app/domain/test/import.test.ts");
  });

  it("refuses duplicate task ids", async () => {
    const plan = goodPlan();
    plan.tasks.push(task("1.3"));
    const problems = await validatePlan(plan, changeDir, UNTICKED, undefined, PATHS);
    expect(problems.join("\n")).toMatch(/\b1\.3\b/);
  });

  it("reports every problem, not only the first", async () => {
    const plan = goodPlan();
    plan.tasks[0] = task("1.1", { scenarios: ["Unknown scenario"], dependsOn: ["1.3"], files: ["package.json"] });
    const problems = await validatePlan(plan, changeDir, UNTICKED, undefined, PATHS);
    // The unknown title, the missing "Import reads every word", the forward dependency and package.json.
    expect(problems).toHaveLength(4);
  });
});
