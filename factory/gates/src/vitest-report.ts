import { relative, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";

/** One test of a Vitest JSON report: its full name (with the `describe` titles) and how it ended. */
export type VitestTest = {
  name: string;
  status: "passed" | "failed" | "skipped";
  failure?: string;
};

/** One test file of a Vitest JSON report, with its path relative to the worktree. */
export type VitestFile = {
  file: string;
  loadError?: string;
  tests: VitestTest[];
};

/**
 * The fields of Vitest's JSON report that the gates read. The format is not a stable API, so
 * these are pinned by a test against a report from the pinned Vitest; anything else may change.
 */
const Report = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string().optional(),
      assertionResults: z.array(
        z.object({
          fullName: z.string(),
          status: z.string(),
          failureMessages: z.array(z.string()).nullish(),
        }),
      ),
    }),
  ),
});

function testStatus(status: string): VitestTest["status"] {
  if (status === "passed" || status === "failed") return status;
  // pending, skipped, todo and disabled tests did not run.
  return "skipped";
}

/** Reads a Vitest JSON report; throws if it lacks the pinned fields. */
export function readVitestReport(report: unknown, root: string): VitestFile[] {
  return Report.parse(report).testResults.map((result) => {
    const tests = result.assertionResults.map((assertion): VitestTest => {
      const test: VitestTest = { name: assertion.fullName, status: testStatus(assertion.status) };
      const failure = assertion.failureMessages?.join("\n");
      if (test.status === "failed" && failure) test.failure = stripVTControlCharacters(failure);
      return test;
    });
    const file: VitestFile = { file: relative(root, result.name).split(sep).join("/"), tests };
    // A file that failed with no tests, or with a message and no test run, failed while it loaded.
    const ran = tests.some((test) => test.status !== "skipped");
    const message = result.message ?? "";
    if ((result.status === "failed" && tests.length === 0) || (message !== "" && !ran)) {
      file.loadError = stripVTControlCharacters(message) || "the file failed to load";
    }
    return file;
  });
}
