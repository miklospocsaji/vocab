/**
 * Checks the planner's `tasks.json` against the change before it is accepted (the `roles` spec,
 * "Plans are checked before they are accepted"). Every problem is reported, each naming the
 * task, scenario or file it is about; an empty list means the plan passes. A failed check is a
 * failed attempt, with these messages as its evidence.
 */
import { basename, posix } from "node:path";
import type { PlanResult } from "@vocab/factory-artifacts";
import { scenarioTitles } from "@vocab/factory-gates";
import { writableFor } from "./config.ts";
import { isWritable } from "./guard.ts";

/** The writable globs, as in the role configs, that a plan's files and tests are checked against. */
export interface PlanPaths {
  /** The implementer's globs: every task's `files` must be writable by it. */
  implementer: readonly string[];
  /** The test author's globs: every task's `tests` must be writable by it, stubs aside. */
  testAuthor: readonly string[];
}

/** A checklist line of `tasks.md`, ticked or not: `- [ ] 1.2 Title` or `- [x] 1.2 Title`. */
const TASK_LINE = /^\s*[-*] \[( |x|X)\] (\d+(?:\.\d+)+)(?=\s|$)/;

interface TaskLine {
  ticked: boolean;
  line: string;
}

/**
 * Validates `plan` against the change in `changeDir` and the planner's `tasksMd`. `previous` is
 * `tasks.md` as it was before the session, on a re-plan: its ticked lines must stay as they were.
 */
export async function validatePlan(
  plan: PlanResult,
  changeDir: string,
  tasksMd: string,
  previous: string | undefined,
  paths: PlanPaths,
): Promise<string[]> {
  const problems: string[] = [];
  const lines = taskLines(tasksMd);
  const position = new Map<string, number>();

  plan.tasks.forEach((task, index) => {
    if (position.has(task.id)) problems.push(`task ${task.id} appears more than once in the plan`);
    else position.set(task.id, index);
  });

  for (const task of plan.tasks) {
    if (!lines.has(task.id)) problems.push(`task ${task.id} has no "- [ ] ${task.id}" line in tasks.md`);
  }

  plan.tasks.forEach((task, index) => {
    for (const dependency of task.dependsOn) {
      const at = position.get(dependency);
      if (dependency === task.id) problems.push(`task ${task.id} depends on itself`);
      else if (at === undefined) problems.push(`task ${task.id} depends on task ${dependency}, which is not in the plan`);
      else if (at > index) problems.push(`task ${task.id} depends on task ${dependency}, which comes later in the plan`);
    }
  });

  const titles = await scenarioTitles(changeDir);
  const known = new Set(titles);
  const assigned = new Set<string>();
  for (const task of plan.tasks) {
    for (const scenario of task.scenarios) {
      if (known.has(scenario)) assigned.add(scenario);
      else problems.push(`task ${task.id} names the scenario "${scenario}", which is not in the change`);
    }
  }
  for (const title of titles) {
    if (!assigned.has(title)) problems.push(`the scenario "${title}" is assigned to no task`);
  }

  const changeId = basename(changeDir);
  const implementer = writableFor({ writable: [...paths.implementer] }, changeId);
  const testAuthor = writableFor({ writable: [...paths.testAuthor] }, changeId);
  for (const task of plan.tasks) {
    for (const file of task.files) {
      if (!isPlainPath(file) || !isWritable(file, implementer)) {
        problems.push(`task ${task.id}: the file ${file} is outside the implementer's paths (${implementer.join(", ")})`);
      }
    }
    for (const test of task.tests) {
      if (!isPlainPath(test) || !isWritable(test, testAuthor)) {
        problems.push(`task ${task.id}: the test ${test} is outside the test author's paths (${testAuthor.join(", ")})`);
      }
    }
  }

  if (previous !== undefined) {
    for (const [id, before] of taskLines(previous)) {
      if (before.ticked && lines.get(id)?.line !== before.line) {
        problems.push(`task ${id} is ticked and must stay as it was in tasks.md: "${before.line}"`);
      }
    }
  }

  return problems;
}

/** The checklist lines of a `tasks.md`, by task id; the first line wins for a repeated id. */
function taskLines(tasksMd: string): Map<string, TaskLine> {
  const lines = new Map<string, TaskLine>();
  for (const raw of tasksMd.split(/\r?\n/)) {
    const match = TASK_LINE.exec(raw);
    const id = match?.[2];
    if (id === undefined || lines.has(id)) continue;
    lines.set(id, { ticked: match?.[1] !== " ", line: raw.trim() });
  }
  return lines;
}

/** A worktree-relative path with no `.`, `..` or empty segments, and not absolute. */
function isPlainPath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && posix.normalize(path) === path && !path.startsWith("../") && path !== "..";
}
