import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCoverage, missingScenarios, scenarioTitles, testNames } from "../src/coverage.ts";
import type { VitestFile } from "../src/vitest-report.ts";
import { fixtures } from "./helpers/worktree.ts";

const worktree = join(fixtures, "coverage");
const changeId = "add-vocab-import";

// What Vitest would report for fixtures/coverage: the comment in import.test.ts is no test.
const report: VitestFile[] = [
  { file: "app/domain/test/import.test.ts", tests: [{ name: "import Scenario: Import reads every book", status: "passed" }] },
  { file: "app/domain/test/practice.test.ts", tests: [{ name: "Scenario: New words are due at once", status: "passed" }] },
];

describe("coverage", () => {
  it("Scenario: Scenario without a test fails coverage", async () => {
    const result = await checkCoverage({ worktree, changeId });
    expect(result.passed).toBe(false);
    expect(result.missing).toContain("Re-import adds only new lookups");
  });

  it("Scenario: Coverage checks only the given scenarios", async () => {
    const scenarios = ["Import reads every book", "New words are due at once"];
    expect(await checkCoverage({ worktree, changeId, scenarios })).toEqual({ passed: true, missing: [] });
    expect(await checkCoverage({ worktree, changeId, scenarios, report })).toEqual({ passed: true, missing: [] });
  });

  it("reads every scenario title of every delta spec of the change", async () => {
    expect((await scenarioTitles(join(worktree, "openspec/changes", changeId))).sort()).toEqual([
      "Import keeps the lookup's sentence",
      "Import reads every book",
      "New words are due at once",
      "Re-import adds only new lookups",
    ]);
  });

  it("covers titles inside describe blocks", async () => {
    const names = await testNames(worktree, { report });
    expect(names).toContain("import Scenario: Import reads every book");
    expect(missingScenarios(["Import reads every book"], names)).toEqual([]);
  });

  it("does not cover a title that only appears in a comment, when a report exists", async () => {
    const result = await checkCoverage({ worktree, changeId, report });
    expect(result.missing.sort()).toEqual(["Import keeps the lookup's sentence", "Re-import adds only new lookups"]);
  });

  it("scans app/ for quoted scenario names in any quote style when there is no report", async () => {
    expect((await testNames(worktree)).sort()).toEqual([
      "Scenario: Import keeps the lookup's sentence",
      "Scenario: Import reads every book",
      "Scenario: New words are due at once",
    ]);
  });

  it("scans the given directory instead of app/", async () => {
    expect(await testNames(worktree, { testsDir: "tools" })).toEqual(["Scenario: Import keeps the lookup's sentence"]);
    const scenarios = ["Import keeps the lookup's sentence"];
    expect(await checkCoverage({ worktree, changeId, scenarios, testsDir: "tools" })).toEqual({ passed: true, missing: [] });
  });

  it("covers a title only when a test name contains it verbatim after Scenario:", () => {
    const names = ["import Scenario: Import reads every book", "import reads every book"];
    expect(missingScenarios(["Import reads every book", "import reads every book"], names)).toEqual(["import reads every book"]);
  });
});
