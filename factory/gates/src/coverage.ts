import { access, glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VitestFile } from "./vitest-report.ts";

async function collect(paths: AsyncIterable<string>): Promise<string[]> {
  const found: string[] = [];
  for await (const path of paths) found.push(path);
  return found.sort();
}

/** The `#### Scenario:` titles of every delta spec of a change; throws if the change does not exist. */
export async function scenarioTitles(changeDir: string): Promise<string[]> {
  await access(changeDir);
  const titles: string[] = [];
  const specs = await collect(glob("specs/*/spec.md", { cwd: changeDir }));
  for (const spec of specs) {
    for (const line of (await readFile(join(changeDir, spec), "utf8")).split("\n")) {
      const match = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line);
      if (match?.[1]) titles.push(match[1]);
    }
  }
  return titles;
}

export type TestNamesOptions = {
  /** A parsed Vitest report; when given, test names come from it instead of a text scan. */
  report?: readonly VitestFile[] | undefined;
  /** Where the text scan looks, relative to the worktree; `app` unless given. */
  testsDir?: string | undefined;
};

/** A quoted `Scenario: <title>` in any quote style, as a test name in source code. */
const QUOTED_SCENARIO = /(["'`])(Scenario: .+?)\1/g;

/**
 * The full names of the worktree's tests: from the Vitest report when there is one, otherwise
 * every quoted `Scenario: <title>` in the test files under `<dir>` (`test/` folders, `*.test.ts`)
 * and in `<dir>/e2e`.
 */
export async function testNames(worktree: string, options: TestNamesOptions = {}): Promise<string[]> {
  if (options.report) return options.report.flatMap((file) => file.tests.map((test) => test.name));
  const dir = options.testsDir ?? "app";
  const patterns = [`${dir}/**/test/**/*.test.ts`, `${dir}/e2e/**/*.ts`];
  const files = await collect(glob(patterns, { cwd: worktree, exclude: (name) => name === "node_modules" || name.endsWith("/node_modules") }));
  const names = new Set<string>();
  for (const file of files) {
    for (const match of (await readFile(join(worktree, file), "utf8")).matchAll(QUOTED_SCENARIO)) {
      if (match[2]) names.add(match[2]);
    }
  }
  return [...names];
}

/** The titles no test name contains as `Scenario: <title>`. */
export function missingScenarios(titles: readonly string[], names: readonly string[]): string[] {
  return titles.filter((title) => !names.some((name) => name.includes(`Scenario: ${title}`)));
}

export type CoverageOptions = TestNamesOptions & {
  worktree: string;
  changeId: string;
  /** The titles to check; every title of the change's delta specs unless given. */
  scenarios?: readonly string[] | undefined;
};

/** The scenario-coverage check: passes when every title is named by a test. */
export async function checkCoverage(options: CoverageOptions): Promise<{ passed: boolean; missing: string[] }> {
  const titles = options.scenarios ?? (await scenarioTitles(join(options.worktree, "openspec", "changes", options.changeId)));
  const missing = missingScenarios(titles, await testNames(options.worktree, options));
  return { passed: missing.length === 0, missing };
}
