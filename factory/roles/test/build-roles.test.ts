// The M3 session roles (add-build-roles task 2.12): each config pinned to design.md's table, and
// the lint rule the test author's stubs rely on. The classifier's config is pinned in
// classifier.test.ts, the proposal author's in proposal-author.test.ts.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DesignResult, ImplementationResult, PlanResult, ReviewResult, TestResult } from "@vocab/factory-artifacts";
import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRole } from "../src/config.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const READ_ONLY = ["Read", "Grep", "Glob"];
const EDITING = [...READ_ONLY, "Edit", "Write"];
const BASH_ALLOWLIST = [
  "Bash(pnpm typecheck)",
  "Bash(pnpm lint)",
  "Bash(pnpm exec vitest run:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
];

const ROLES = [
  {
    name: "architect",
    model: "claude-opus-5-5",
    runsIn: "worker",
    tools: EDITING,
    allow: EDITING,
    writable: ["openspec/changes/{changeId}/design.md", "app/contracts/src/**"],
    maxTurns: 40,
    maxBudgetUsd: 1.5,
    resultSchema: "design-result",
    schema: DesignResult,
  },
  {
    name: "design-reviewer",
    model: "claude-sonnet-5-5",
    runsIn: "worker",
    tools: READ_ONLY,
    allow: READ_ONLY,
    writable: [],
    maxTurns: 20,
    maxBudgetUsd: 0.5,
    resultSchema: "review-result",
    schema: ReviewResult,
  },
  {
    name: "planner",
    model: "claude-sonnet-5-5",
    runsIn: "worker",
    tools: EDITING,
    allow: EDITING,
    writable: ["openspec/changes/{changeId}/tasks.md"],
    maxTurns: 25,
    maxBudgetUsd: 0.75,
    resultSchema: "plan-result",
    schema: PlanResult,
  },
  {
    name: "test-author",
    model: "claude-sonnet-5-5",
    runsIn: "build",
    tools: [...EDITING, "Bash"],
    allow: [...EDITING, ...BASH_ALLOWLIST],
    writable: ["app/*/test/**", "app/e2e/**", "{taskStubs}"],
    maxTurns: 40,
    maxBudgetUsd: 1,
    resultSchema: "test-result",
    schema: TestResult,
  },
  {
    name: "implementer",
    model: "claude-sonnet-5-5",
    runsIn: "build",
    tools: [...EDITING, "Bash"],
    allow: [...EDITING, ...BASH_ALLOWLIST],
    writable: ["app/*/src/**", "!app/contracts/**", "infra/app-stack.ts", "infra/preview-stack.ts", "infra/app/**"],
    maxTurns: 60,
    maxBudgetUsd: 1.5,
    resultSchema: "implementation-result",
    schema: ImplementationResult,
  },
] as const;

describe("the M3 session roles", () => {
  for (const expected of ROLES) {
    const { schema, ...config } = expected;

    it(`${expected.name}: tools, writable globs, runsIn, model and budget match design.md`, async () => {
      const role = await loadRole(expected.name);
      expect(role).toMatchObject({ ...config, skills: [], authMode: "subscription" });
      // Exact lists, not just a superset.
      expect(role.tools).toEqual(config.tools);
      expect(role.allow).toEqual(config.allow);
      expect(role.writable).toEqual(config.writable);
      expect(role.schema).toBe(schema);
    });

    it(`${expected.name}: the prompt fences untrusted data and says what the role returns`, async () => {
      const role = await loadRole(expected.name);
      expect(role.prompt).toMatch(/untrusted/i);
      expect(role.prompt).toContain("## What you may write");
      expect(role.prompt).toContain("structured output");
    });
  }

  it("the design reviewer has no tool that writes", async () => {
    const role = await loadRole("design-reviewer");
    for (const tool of ["Edit", "Write", "Bash", "NotebookEdit"]) expect(role.tools).not.toContain(tool);
  });

  it("the test author's prompt states the stub rules", async () => {
    const { prompt } = await loadRole("test-author");
    expect(prompt).toContain('it("Scenario: <exact title>"');
    expect(prompt).toContain('new Error("not implemented")');
    expect(prompt).toContain("Promise.reject");
    expect(prompt).toContain("`_`");
  });

  it("the implementer's prompt names the checks to run before returning", async () => {
    const { prompt } = await loadRole("implementer");
    for (const command of ["pnpm exec vitest run", "pnpm typecheck", "pnpm lint"]) expect(prompt).toContain(command);
  });
});

/** One sync and one async stub, as the test author writes them under `app/domain/src/`. */
const STUB = `export function countWords(_text: string, _locale: string): number {
  throw new Error("not implemented");
}

export function loadBook(_path: string, _limit: number): Promise<string[]> {
  return Promise.reject(new Error("not implemented"));
}
`;

describe("linting the test author's stubs", () => {
  // A copy of the repo's lint setup in a temp dir, since the type-aware rules only lint files on
  // disk that a tsconfig includes, and the real app/ and factory/ trees stay untouched.
  let root: string;
  let eslint: ESLint;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vocab-stub-lint-"));
    for (const file of ["eslint.config.js", "tsconfig.base.json", "app/domain/tsconfig.json", "factory/roles/tsconfig.json"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(REPO_ROOT, file), join(root, file));
    }
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
    for (const dir of ["app/domain/src", "factory/roles/src"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "stub.ts"), STUB);
    }
    eslint = new ESLint({ cwd: root });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a sync and an async stub with _ parameters pass under app/domain/src/", { timeout: 60_000 }, async () => {
    const [result] = await eslint.lintFiles(["app/domain/src/stub.ts"]);
    expect(result?.messages.map((message) => `${String(message.ruleId)}: ${message.message}`)).toEqual([]);
    expect(result?.errorCount).toBe(0);
  });

  it("the same stub under factory/ still fails on its unused parameters", { timeout: 60_000 }, async () => {
    const [result] = await eslint.lintFiles(["factory/roles/src/stub.ts"]);
    const rules = result?.messages.map((message) => message.ruleId) ?? [];
    expect(rules).toContain("@typescript-eslint/no-unused-vars");
    expect(rules.filter((rule) => rule === "@typescript-eslint/no-unused-vars")).toHaveLength(4);
    // Only the unused-parameter rule: the stubs are otherwise clean, so this is the rule under test.
    expect(new Set(rules)).toEqual(new Set(["@typescript-eslint/no-unused-vars"]));
  });
});
