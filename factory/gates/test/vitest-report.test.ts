import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readVitestReport, type VitestFile } from "../src/vitest-report.ts";
import { makeWorktree, removeWorktree } from "./helpers/worktree.ts";

let worktree: string;
let reportDir: string;
let raw: unknown;

// One real report from the pinned Vitest over fixtures/report (and the workspace's add.test.ts),
// read by every test below.
beforeAll(async () => {
  worktree = await makeWorktree("report");
  reportDir = await mkdtemp(join(tmpdir(), "gates-report-"));
  const outputFile = join(reportDir, "report.json");
  const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", CI: "1" };
  // Vitest exits 1 because the fixture's tests fail; the report is still written.
  await promisify(execFile)("pnpm", ["exec", "vitest", "run", "--project", "unit", "--reporter=json", `--outputFile=${outputFile}`, "app/"], { cwd: worktree, env })
    .catch(() => undefined);
  raw = JSON.parse(await readFile(outputFile, "utf8"));
}, 60_000);

afterAll(async () => {
  await removeWorktree(worktree);
  await rm(reportDir, { recursive: true, force: true });
});

function file(name: string): VitestFile {
  const files = readVitestReport(raw, worktree);
  const found = files.find((entry) => entry.file === `app/demo/test/${name}`);
  if (!found) throw new Error(`no ${name} in the report: ${files.map((entry) => entry.file).join(", ")}`);
  return found;
}

describe("readVitestReport", () => {
  it("pins the report fields the red check reads", () => {
    const report = raw as { testResults?: unknown };
    expect(Array.isArray(report.testResults)).toBe(true);
    const results = report.testResults as Record<string, unknown>[];
    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(typeof result["name"]).toBe("string");
      expect(["passed", "failed"]).toContain(result["status"]);
      expect(typeof result["message"]).toBe("string");
      expect(Array.isArray(result["assertionResults"])).toBe(true);
      for (const test of result["assertionResults"] as Record<string, unknown>[]) {
        expect(typeof test["fullName"]).toBe("string");
        expect(typeof test["status"]).toBe("string");
        expect(Array.isArray(test["failureMessages"])).toBe(true);
      }
    }
  });

  it("refuses a report without the pinned fields", () => {
    expect(() => readVitestReport({}, worktree)).toThrow();
    expect(() => readVitestReport({ testResults: [{ name: "a.test.ts" }] }, worktree)).toThrow();
  });

  it("names each file relative to the worktree", () => {
    expect(readVitestReport(raw, worktree).map((entry) => entry.file).sort()).toEqual([
      "app/demo/test/add.test.ts",
      "app/demo/test/assertion.test.ts",
      "app/demo/test/missing-import.test.ts",
      "app/demo/test/passing.test.ts",
      "app/demo/test/syntax-error.test.ts",
      "app/demo/test/thrown.test.ts",
    ]);
  });

  it("reads a passing test by its full name, describe titles included", () => {
    expect(file("passing.test.ts")).toEqual({
      file: "app/demo/test/passing.test.ts",
      tests: [{ name: "report Scenario: Passes", status: "passed" }],
    });
  });

  it("reads an assertion failure as a failed test", () => {
    const entry = file("assertion.test.ts");
    expect(entry.loadError).toBeUndefined();
    expect(entry.tests.map((test) => [test.name, test.status])).toEqual([["fails an assertion", "failed"]]);
    expect(entry.tests[0]?.failure).toContain("expected 2 to be 3");
  });

  it("reads an error thrown inside a test as a failed test, not a load error", () => {
    const entry = file("thrown.test.ts");
    expect(entry.loadError).toBeUndefined();
    expect(entry.tests.map((test) => [test.name, test.status])).toEqual([["throws inside the test", "failed"]]);
    expect(entry.tests[0]?.failure).toContain("not implemented");
  });

  it("reads a missing import as a load error naming the module", () => {
    const entry = file("missing-import.test.ts");
    expect(entry.tests).toEqual([]);
    expect(entry.loadError).toContain("../src/nowhere.ts");
  });

  it("reads a syntax error as a load error", () => {
    const entry = file("syntax-error.test.ts");
    expect(entry.tests).toEqual([]);
    expect(entry.loadError).toContain("syntax-error.test.ts");
    expect(entry.loadError).not.toContain("\u001b[");
  });
});
