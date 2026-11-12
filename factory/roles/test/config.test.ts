import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadRole, writableFor } from "../src/config.ts";
import { createPathGuard, isWritable } from "../src/guard.ts";

const ROLE = "sample-role";
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const ROLES_DIR = join(REPO_ROOT, "factory/roles");

const validConfig = {
  name: ROLE,
  model: "claude-haiku-5-5",
  runsIn: "worker",
  tools: ["Read", "Grep", "Glob", "Write"],
  allow: ["Read", "Grep", "Glob"],
  writable: ["openspec/changes/{changeId}/proposal.md"],
  skills: [],
  maxTurns: 5,
  maxBudgetUsd: 0.1,
  resultSchema: "proposal-result",
  authMode: "subscription",
};

let root: string;

function writeRole(config: Record<string, unknown>, prompt: string | null = "You are a sample role.\n"): void {
  mkdirSync(join(root, "factory/roles"), { recursive: true });
  writeFileSync(join(root, "factory/roles", `${ROLE}.yaml`), stringify(config));
  if (prompt !== null) writeFileSync(join(root, "factory/roles", `${ROLE}.md`), prompt);
}

/** The names of the repository's roles: every `factory/roles/<role>.yaml`. */
function repoRoles(): string[] {
  return readdirSync(ROLES_DIR)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => file.slice(0, -".yaml".length))
    .sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vocab-roles-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadRole", () => {
  // Control: without it, a loadRole that always throws would pass the scenarios below.
  it("loads a valid config", async () => {
    writeRole(validConfig);
    const role = await loadRole(ROLE, { root });
    expect(role.name).toBe(ROLE);
    expect(role.runsIn).toBe("worker");
    expect(role.writable).toEqual(validConfig.writable);
    expect(role.prompt).toBe("You are a sample role.");
  });

  it("loads a role that runs in the build container", async () => {
    writeRole({ ...validConfig, runsIn: "build", tools: [...validConfig.tools, "Bash"], allow: [...validConfig.allow, "Bash(pnpm lint)"] });
    expect((await loadRole(ROLE, { root })).runsIn).toBe("build");
  });

  it("reads the prompt from factory/roles/<role>.md, not .claude/agents", async () => {
    writeRole(validConfig, null);
    mkdirSync(join(root, ".claude/agents"), { recursive: true });
    writeFileSync(join(root, ".claude/agents", `${ROLE}.md`), "You are in the wrong place.\n");
    await expect(loadRole(ROLE, { root })).rejects.toThrow(new RegExp(`${ROLE}[\\s\\S]*factory/roles/${ROLE}\\.md`));

    writeFileSync(join(root, "factory/roles", `${ROLE}.md`), "You are a sample role.\n");
    expect((await loadRole(ROLE, { root })).prompt).toBe("You are a sample role.");
  });

  it("Scenario: Invalid config is refused (writable paths missing)", async () => {
    const config: Record<string, unknown> = { ...validConfig };
    delete config["writable"];
    writeRole(config);
    await expect(loadRole(ROLE, { root })).rejects.toThrow(new RegExp(`${ROLE}[\\s\\S]*writable`));
  });

  it("Scenario: Invalid config is refused (unknown result schema)", async () => {
    writeRole({ ...validConfig, resultSchema: "no-such-schema" });
    await expect(loadRole(ROLE, { root })).rejects.toThrow(new RegExp(`${ROLE}[\\s\\S]*resultSchema`));
  });

  it("Scenario: Invalid config is refused (prompt file missing)", async () => {
    writeRole(validConfig, null);
    await expect(loadRole(ROLE, { root })).rejects.toThrow(new RegExp(`${ROLE}[\\s\\S]*factory/roles/${ROLE}\\.md`));
  });

  it("Scenario: Invalid config is refused (runsIn missing)", async () => {
    const config: Record<string, unknown> = { ...validConfig };
    delete config["runsIn"];
    writeRole(config);
    await expect(loadRole(ROLE, { root })).rejects.toThrow(new RegExp(`${ROLE}[\\s\\S]*runsIn`));
  });

  it("Scenario: Config without a place to run is refused", async () => {
    const missing: Record<string, unknown> = { ...validConfig };
    delete missing["runsIn"];
    writeRole(missing);
    await expect(loadRole(ROLE, { root })).rejects.toMatchObject({ name: "RoleConfigError", role: ROLE, field: "runsIn" });

    for (const runsIn of ["lambda", "", "Worker"]) {
      writeRole({ ...validConfig, runsIn });
      await expect(loadRole(ROLE, { root }), runsIn).rejects.toMatchObject({ name: "RoleConfigError", role: ROLE, field: "runsIn" });
      await expect(loadRole(ROLE, { root }), runsIn).rejects.toThrow(new RegExp(`${ROLE}[\\s\\S]*runsIn`));
    }
  });

  it("refuses a worker role with Bash among its tools or pre-approved calls", async () => {
    writeRole({ ...validConfig, tools: [...validConfig.tools, "Bash"] });
    await expect(loadRole(ROLE, { root })).rejects.toMatchObject({ name: "RoleConfigError", role: ROLE, field: "tools" });

    writeRole({ ...validConfig, allow: [...validConfig.allow, "Bash(pnpm lint)"] });
    await expect(loadRole(ROLE, { root })).rejects.toMatchObject({ name: "RoleConfigError", role: ROLE, field: "allow" });
  });

  describe("the runner's deny list", () => {
    const buildConfig = (allow: string[]) => ({ ...validConfig, runsIn: "build", tools: [...validConfig.tools, "Bash"], allow: [...validConfig.allow, ...allow] });

    it("Scenario: Allowlist overlapping the deny list is refused", async () => {
      writeRole(buildConfig(["Bash(pnpm lint)", "Bash(git:*)"]));
      const load = loadRole(ROLE, { root });
      await expect(load).rejects.toMatchObject({ name: "RoleConfigError", role: ROLE, field: "allow" });
      await expect(loadRole(ROLE, { root })).rejects.toThrow(ROLE);
      await expect(loadRole(ROLE, { root })).rejects.toThrow("Bash(git:*)");
      await expect(loadRole(ROLE, { root })).rejects.toThrow("git push");
    });

    it("refuses a bare Bash, Bash(*), a denied rule and a prefix rule that covers a denied command", async () => {
      for (const [rule, denied] of [
        ["Bash", "git push"],
        ["Bash(*)", "git push"],
        ["Bash(curl:*)", "curl"],
        ["Bash(git push:*)", "git push"],
        ["Bash(pnpm:*)", "pnpm add"],
        ["Bash(n:*)", "nc"],
      ] as const) {
        writeRole(buildConfig([rule]));
        await expect(loadRole(ROLE, { root }), rule).rejects.toMatchObject({ name: "RoleConfigError", role: ROLE, field: "allow" });
        await expect(loadRole(ROLE, { root }), rule).rejects.toThrow(denied);
      }
    });

    // Control: the build roles' own allowlist loads, so the check is not a blanket refusal of Bash.
    it("loads an allowlist that no denied command falls under", async () => {
      writeRole(buildConfig(["Bash(pnpm typecheck)", "Bash(pnpm lint)", "Bash(pnpm exec vitest run:*)", "Bash(git status:*)", "Bash(git diff:*)"]));
      expect((await loadRole(ROLE, { root })).allow).toContain("Bash(git diff:*)");
    });
  });
});

describe("the repository's roles", () => {
  it("Scenario: No role is registered as an agent", () => {
    const agents = join(REPO_ROOT, ".claude/agents");
    expect(existsSync(agents) ? readdirSync(agents) : []).toEqual([]);

    const prompts = readdirSync(ROLES_DIR).filter((file) => file.endsWith(".md"));
    expect(prompts.length).toBeGreaterThan(0);
    for (const role of repoRoles()) expect(prompts, role).toContain(`${role}.md`);
    for (const prompt of prompts) {
      const text = readFileSync(join(ROLES_DIR, prompt), "utf8");
      expect(text, prompt).not.toMatch(/^\s*---/);
      expect(text.trim(), prompt).not.toBe("");
    }
  });

  it("Scenario: Worker roles have no Bash", async () => {
    const roles = await Promise.all(repoRoles().map((name) => loadRole(name)));
    const workerRoles = roles.filter((role) => role.runsIn === "worker");
    // Control: the proposal author runs in the worker, so the loop below is never empty.
    expect(workerRoles.map((role) => role.name)).toContain("proposal-author");
    for (const role of workerRoles) {
      expect(role.tools, role.name).not.toContain("Bash");
      expect(role.allow.filter((rule) => rule === "Bash" || rule.startsWith("Bash(")), role.name).toEqual([]);
    }
  });
});

describe("writable globs", () => {
  const IMPLEMENTER = ["app/*/src/**", "!app/contracts/**", "infra/app-stack.ts"];

  it("a ! exclusion makes a path unwritable", () => {
    expect(isWritable("app/domain/src/import.ts", IMPLEMENTER)).toBe(true);
    expect(isWritable("infra/app-stack.ts", IMPLEMENTER)).toBe(true);
    expect(isWritable("app/contracts/src/index.ts", IMPLEMENTER)).toBe(false);
    expect(isWritable("app/domain/test/import.test.ts", IMPLEMENTER)).toBe(false);
    // Order does not matter: an exclusion listed first still excludes.
    expect(isWritable("app/contracts/src/index.ts", ["!app/contracts/**", "app/*/src/**"])).toBe(false);
    // Exclusions alone allow nothing.
    expect(isWritable("app/domain/src/import.ts", ["!app/contracts/**"])).toBe(false);
  });

  it("the path guard applies a ! exclusion", async () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), "vocab-writable-")));
    try {
      const guard = createPathGuard({ role: "implementer", worktree, writable: IMPLEMENTER });
      const decide = async (filePath: string): Promise<string | undefined> => {
        const input: PreToolUseHookInput = {
          hook_event_name: "PreToolUse",
          session_id: "session",
          transcript_path: join(worktree, "transcript.jsonl"),
          cwd: worktree,
          tool_name: "Write",
          tool_input: { file_path: filePath, content: "x" },
          tool_use_id: "tool-use",
        };
        const output: HookJSONOutput = await guard(input, "tool-use", { signal: new AbortController().signal });
        const specific = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
        return specific?.hookEventName === "PreToolUse" ? specific.permissionDecision : undefined;
      };
      expect(await decide("app/domain/src/import.ts")).toBeUndefined();
      expect(await decide("app/contracts/src/index.ts")).toBe("deny");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("{taskStubs} expands to the given files", () => {
    const testAuthor = { writable: ["app/*/test/**", "app/e2e/**", "{taskStubs}"] };
    const stubs = ["app/domain/src/import.ts", "app/domain/src/parse.ts"];

    expect(writableFor(testAuthor, "add-sample", stubs)).toEqual(["app/*/test/**", "app/e2e/**", ...stubs]);
    // No stubs: the placeholder is dropped, not left as a glob.
    expect(writableFor(testAuthor, "add-sample", [])).toEqual(["app/*/test/**", "app/e2e/**"]);
    expect(writableFor(testAuthor, "add-sample")).toEqual(["app/*/test/**", "app/e2e/**"]);

    const globs = writableFor(testAuthor, "add-sample", stubs);
    expect(isWritable("app/domain/src/import.ts", globs)).toBe(true);
    expect(isWritable("app/domain/src/other.ts", globs)).toBe(false);
  });

  it("fills in {changeId} as before", () => {
    expect(writableFor({ writable: ["openspec/changes/{changeId}/tasks.md"] }, "add-sample")).toEqual(["openspec/changes/add-sample/tasks.md"]);
  });
});
