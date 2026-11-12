/**
 * The fixture change of the M3 role live tests (add-build-roles task 2.13): `add-lookup-counts`,
 * one requirement with two scenarios in `vocab-import`, in a temp git repo that holds only what the
 * roles read. Each test copies the change folder up to its role's step: the proposal and delta
 * spec for the architect, plus a design for the reviewer and the planner.
 *
 * Every run is in api-key mode, capped at $0.50, as the task asks. The key comes from the
 * git-ignored `.env.local` (vitest.live-setup.ts); a run without one fails, never skips.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Role } from "../src/config.ts";
import type { PromptArtifact, PromptIssue } from "../src/prompt.ts";
import { removeDir, writeFile, type LiveAttempt } from "./live-harness.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const FIXTURE = join(import.meta.dirname, "fixtures/add-lookup-counts");
export const OPENSPEC = join(REPO, "node_modules/.bin/openspec");

export const CHANGE_ID = "add-lookup-counts";
export const CHANGE = `openspec/changes/${CHANGE_ID}`;
export const SCENARIOS = ["Lookups of one word are counted", "Words differing only in case are counted together"];
/** Task 2.13: each live run stays under this. */
export const LIVE_CAP_USD = 0.5;

export const ISSUE: PromptIssue = {
  title: "Count lookups per word",
  body: "Show how often I looked up each word, so practice can start with the words I look up most. Treat \"The\" and \"the\" as one word.",
};

/** The contract the fixture design names; written for the reviewer and the planner, as the architect would have. */
const LOOKUP_CONTRACT = `export interface Lookup {
  word: string;
  bookId: string;
  timestamp: number;
}
`;

/** The parent env with api-key mode forced; throws if the key is missing, so the run fails rather than skips. */
export function apiKeyEnv(): Record<string, string | undefined> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error("ANTHROPIC_API_KEY is not set: add the factory workspace's key to .env.local (task 2.13 runs in api-key mode)");
  }
  return { ...process.env, FACTORY_AUTH_MODE: "api-key" };
}

/** The role as configured, with its budget capped for the live run. */
export function capped(role: Role): Role {
  return { ...role, maxBudgetUsd: Math.min(role.maxBudgetUsd, LIVE_CAP_USD) };
}

export type DesignFixture = "none" | "design.md" | "design-contradiction.md";

export interface ChangeRepo {
  root: string;
  /** The files in the change folder, as a handler passes them to the role. */
  changeFiles(): PromptArtifact[];
  /** The current `vocab-import` spec. */
  specs(): PromptArtifact[];
  /** Paths changed since the fixture commit, committed or not, untracked included. */
  changedPaths(): string[];
  remove(): void;
}

/**
 * A temp git repo with `openspec/config.yaml`, the current `vocab-import` spec, the app's
 * contract and domain entry points, and the fixture change. With a design, the change folder gets
 * it as `design.md`, and the contract it names is in place. Everything is committed, so a test can
 * list what the session changed.
 */
export function makeChangeRepo(design: DesignFixture): ChangeRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vocab-live-change-")));
  const copy = (from: string, to: string) => {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    copyFileSync(from, join(root, to));
  };
  for (const path of ["openspec/config.yaml", "openspec/specs/vocab-import/spec.md", "app/contracts/src/index.ts", "app/domain/src/index.ts"]) {
    copy(join(REPO, path), path);
  }
  for (const path of ["proposal.md", "specs/vocab-import/spec.md", ".openspec.yaml"]) copy(join(FIXTURE, path), `${CHANGE}/${path}`);
  if (design !== "none") {
    copy(join(FIXTURE, design), `${CHANGE}/design.md`);
    writeFile(root, "app/contracts/src/lookup.ts", LOOKUP_CONTRACT);
    writeFile(root, "app/contracts/src/index.ts", 'export type { Lookup } from "./lookup.ts";\n');
  }

  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  const base = git("rev-parse", "HEAD").trim();

  const read = (path: string): PromptArtifact => ({ path, content: readFileSync(join(root, path), "utf8") });
  return {
    root,
    changeFiles: () => {
      const folder = join(root, CHANGE);
      return readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)))
        .sort()
        .map(read);
    },
    specs: () => [read("openspec/specs/vocab-import/spec.md")],
    changedPaths: () => {
      const tracked = git("diff", "--name-only", "-z", base).split("\0");
      const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0");
      return [...new Set([...tracked, ...untracked].filter((path) => path !== ""))].sort();
    },
    remove: () => {
      removeDir(root);
    },
  };
}

/** The file's text, or undefined if the session never wrote it. */
export function readIfExists(root: string, path: string): string | undefined {
  return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined;
}

/** The session's turns, cost and outcome, printed for the task's record. */
export function report(label: string, attempt: LiveAttempt, extra: Record<string, unknown> = {}): void {
  const outcome = attempt.outcome instanceof Error ? { error: attempt.outcome.message } : attempt.outcome;
  console.log(
    [
      `${label}: $${attempt.costUsd.toFixed(4)}, ${String(attempt.result?.num_turns ?? "?")} turns`,
      ...Object.entries(extra).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`),
      `result: ${JSON.stringify(outcome, null, 2)}`,
    ].join("\n"),
  );
}
