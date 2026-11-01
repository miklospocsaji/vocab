/**
 * Test helper: a scripted fake of the role runner (`RunRole`). Each call plays the next step
 * of the script the way the real runner would end an attempt:
 * - it records an init message with the step's `apiKeySource` through the Recorder, and fails
 *   with `auth-mode-mismatch` when that does not match the role's auth mode
 * - it writes the step's files into the change folder of the worktree
 * - it records a result message with the step's cost
 * - it runs the factory's real `openspec validate <id> --strict --json` on the worktree and
 *   fails with `invalid-change` and the JSON report as evidence, as the real runner does
 * Every call is kept, with the work item and evidence the handler passed.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AttemptFailed, type Recorder, type RetryEvidence, type Role, type RunRole, type WorkItem } from "@vocab/factory-roles";
import { init, result } from "../../ledger/test/messages.ts";

const run = promisify(execFile);
const OPENSPEC = resolve(import.meta.dirname, "../../../node_modules/.bin/openspec");

type ApiKeySource = Parameters<typeof init>[0];

/** The `apiKeySource` the init message reports in each auth mode, as the real runner checks it. */
const API_KEY_SOURCE: Record<Role["authMode"], ApiKeySource> = { "api-key": "ANTHROPIC_API_KEY", subscription: "none" };

export interface FakeStep {
  /** Files to write, relative to the change folder `openspec/changes/<id>/`. */
  files?: Record<string, string>;
  /** Defaults to the one the role's auth mode expects. */
  apiKeySource?: ApiKeySource;
  /** The role's result when the change validates; defaults to `validResult(changeId)`. */
  result?: unknown;
  /** The SDK's estimated cost of the attempt; defaults to 0.25. */
  costUsd?: number;
}

export interface FakeCall {
  role: string;
  item: WorkItem;
  evidence: RetryEvidence | undefined;
}

export interface FakeRoleRunner {
  runRole: RunRole;
  /** Every call, in order. */
  calls: FakeCall[];
}

export function createFakeRoleRunner(recorder: Recorder, steps: FakeStep[]): FakeRoleRunner {
  const calls: FakeCall[] = [];
  const script = [...steps];

  const runRole: RunRole = async (role, item, evidence) => {
    calls.push({ role: role.name, item: structuredClone(item), evidence });
    const step = script.shift();
    if (step === undefined) throw new Error(`fake role runner: call ${String(calls.length)} has no scripted step`);

    const expected = API_KEY_SOURCE[role.authMode];
    const reported = step.apiKeySource ?? expected;
    await recorder.record(item.id, role.name, init(reported));
    if (reported !== expected) {
      throw new AttemptFailed("auth-mode-mismatch", `role ${role.name} is configured for ${role.authMode}, but the session reported apiKeySource ${reported}`);
    }

    const folder = join(item.worktree, "openspec/changes", item.changeId);
    for (const [path, content] of Object.entries(step.files ?? {})) {
      await mkdir(dirname(join(folder, path)), { recursive: true });
      await writeFile(join(folder, path), content);
    }
    await recorder.record(item.id, role.name, result({ input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 }, step.costUsd ?? 0.25));

    await validate(item);
    return step.result ?? validResult(item.changeId);
  };

  return { runRole, calls };
}

/** A proposal-author result (the `proposal-result` schema) for a change that validates. */
export function validResult(changeId: string): Record<string, unknown> {
  return { changeId, capabilities: ["vocab-import"], complexity: "small", summary: "Import Kindle lookups.", openQuestions: [] };
}

async function validate(item: WorkItem): Promise<void> {
  const env = { ...process.env, OPENSPEC_TELEMETRY: "0", PATH: [dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter) };
  try {
    await run(OPENSPEC, ["validate", item.changeId, "--strict", "--json", "--no-interactive"], { cwd: item.worktree, env });
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim() !== "") throw new AttemptFailed("invalid-change", stdout.trim());
    throw error;
  }
}

/** Change-folder files for the fake's steps. */
export const CHANGE_FILES = {
  proposal: ["# Proposal", "", "## Why", "", "Owners want their Kindle lookups in the app.", "", "## What Changes", "", "- Import the lookups from a Kindle vocab.db.", ""].join("\n"),
  metadata: "schema: spec-driven\ncreated: 2026-11-01\nx-complexity: small\n",
  spec: [
    "## Purpose",
    "Importing Kindle lookups.",
    "",
    "## ADDED Requirements",
    "",
    "### Requirement: Lookups are imported",
    "The importer SHALL import every lookup in a Kindle vocab.db.",
    "",
    "#### Scenario: Lookups are imported",
    "- **WHEN** the owner uploads a vocab.db",
    "- **THEN** every lookup in it is stored",
    "",
  ].join("\n"),
  /** A requirement without a scenario, which strict validation rejects. */
  specWithoutScenario: [
    "## Purpose",
    "Importing Kindle lookups.",
    "",
    "## ADDED Requirements",
    "",
    "### Requirement: Lookups are imported",
    "The importer SHALL import every lookup in a Kindle vocab.db.",
    "",
  ].join("\n"),
};
