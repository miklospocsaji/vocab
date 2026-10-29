import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadRole } from "../src/config.ts";

const ROLE = "sample-role";

const validConfig = {
  name: ROLE,
  model: "claude-haiku-5-5",
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

function writeRole(config: Record<string, unknown>, prompt: string | null = "---\nname: sample-role\n---\nYou are a sample role.\n"): void {
  mkdirSync(join(root, "factory/roles"), { recursive: true });
  writeFileSync(join(root, "factory/roles", `${ROLE}.yaml`), stringify(config));
  if (prompt !== null) {
    mkdirSync(join(root, ".claude/agents"), { recursive: true });
    writeFileSync(join(root, ".claude/agents", `${ROLE}.md`), prompt);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vocab-roles-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadRole", () => {
  // Control: without it, a loadRole that always throws would pass the scenario below.
  it("loads a valid config", async () => {
    writeRole(validConfig);
    const role = await loadRole(ROLE, { root });
    expect(role.name).toBe(ROLE);
    expect(role.writable).toEqual(validConfig.writable);
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
    await expect(loadRole(ROLE, { root })).rejects.toThrow(new RegExp(`${ROLE}[\\s\\S]*\\.claude/agents/${ROLE}\\.md`));
  });
});
