/**
 * End to end in Docker (add-build-roles task 2.15, step M3.2's exit): one task of the fixture
 * change `add-lookup-counts`, through `factory-build` in the worker image's `build` target and an
 * `FsStore` mounted at `/store`. The test author's outcome must pass the red gate, then, with its
 * patch committed as the worker's Record step would, the implementer's must pass the green gate.
 *
 * The remote is a bare clone of this repository at HEAD plus the fixture change. Git in the
 * container refuses a repository owned by another user, so the container copies it to its own
 * `/tmp` and then execs the real entry point; in the cloud the clone URL is GitHub's.
 *
 * Api-key mode, with the roles' own budgets ($1.00 and $1.50). Needs Docker and ANTHROPIC_API_KEY
 * in .env.local. The cost, the turns and the wall time of each role are printed for the task's
 * record.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BuildOutcome, GatesResult } from "@vocab/factory-artifacts";
import { redact } from "@vocab/factory-gates";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const FIXTURE = join(REPO_ROOT, "factory/roles/test/fixtures/add-lookup-counts");
const BUILD_IMAGE = `factory-worker-build:e2e-${randomBytes(4).toString("hex")}`;
const CHANGE_ID = "add-lookup-counts";
const CHANGE = `openspec/changes/${CHANGE_ID}`;
const SCENARIOS = ["Lookups of one word are counted", "Words differing only in case are counted together"];
const TASK = {
  id: "1.1",
  title: "Count lookups per word",
  dependsOn: [],
  files: ["app/domain/src/lookup-counts.ts"],
  scenarios: SCENARIOS,
  tests: ["app/domain/test/lookup-counts.test.ts"],
};
const KEY = "ANTHROPIC_API_KEY";

/** Empty until beforeAll has made them, so afterAll cleans up only what exists. */
let parent = "";
let work = "";
let remote = "";
let store = "";

interface RoleRun {
  status: number | null;
  output: string;
  wallMs: number;
  outcome: BuildOutcome;
  gates: GatesResult | undefined;
  costUsd: number;
  turns: number | undefined;
}
const runs: Record<string, RoleRun> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8" });
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** One `factory-build <role> --input <key>` run in the build image, as a local run starts it. */
function factoryBuild(role: string, baseCommit: string, attempt: string): RoleRun {
  const prefix = `work-items/${CHANGE_ID}/tasks/${TASK.id}/${role}/${attempt}`;
  put(store, `${prefix}/input.json`, `${JSON.stringify({ changeId: CHANGE_ID, branch: CHANGE_ID, baseCommit, cloneUrl: "/tmp/remote.git", task: TASK, coveredSoFar: SCENARIOS }, null, 2)}\n`);
  // The container's factory user (uid 10001) writes its outputs next to the input.
  for (let dir = prefix; dir !== "."; dir = dirname(dir)) chmodSync(join(store, dir), 0o777);

  const started = performance.now();
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--env",
      KEY,
      "--env",
      "FACTORY_AUTH_MODE=api-key",
      "--env",
      "FACTORY_STORE_DIR=/store",
      "--mount",
      `type=bind,source=${store},destination=/store`,
      "--mount",
      `type=bind,source=${remote},destination=/seed/remote.git,readonly`,
      "--entrypoint",
      "sh",
      BUILD_IMAGE,
      "-c",
      'cp -R /seed/remote.git /tmp/remote.git && exec node /app/factory/worker/src/build-main.ts "$@"',
      "factory-build",
      role,
      "--input",
      `${prefix}/input.json`,
    ],
    { encoding: "utf8", env: { PATH: process.env["PATH"], [KEY]: process.env[KEY] }, maxBuffer: 64 * 1024 * 1024 },
  );
  const wallMs = Math.round(performance.now() - started);
  const output = redact(`${run.stdout}${run.stderr}`, [process.env[KEY] ?? ""].filter((value) => value !== ""));
  console.log(`--- factory-build ${role} (exit ${String(run.status)}, ${String(wallMs)} ms)\n${output}`);

  const read = (key: string) => readFileSync(join(store, key), "utf8");
  const outcome = BuildOutcome.parse(JSON.parse(read(`${prefix}/outcome.json`)));
  const gates = outcome.gates === undefined ? undefined : GatesResult.parse(JSON.parse(read(outcome.gates)));
  const messages = read(outcome.messages)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type?: string; total_cost_usd?: number; num_turns?: number });
  const result = messages.findLast((message) => message.type === "result");
  const roleRun = { status: run.status, output, wallMs, outcome, gates, costUsd: result?.total_cost_usd ?? 0, turns: result?.num_turns };
  console.log(
    `${role}: ${outcome.outcome}${outcome.reason === undefined ? "" : ` (${outcome.reason})`}, $${roleRun.costUsd.toFixed(4)}, ${String(roleRun.turns ?? "?")} turns, ${String(wallMs)} ms wall\n` +
      `gates: ${JSON.stringify(gates?.checks.map((check) => [check.name, check.passed]))}\n` +
      `roleResult: ${JSON.stringify(outcome.roleResult, null, 2)}\n--- patch\n${read(outcome.patch)}`,
  );
  runs[role] = roleRun;
  return roleRun;
}

/** Commits a build role's patch on the change branch and pushes it, as the worker's Record step will. */
function record(role: string, patchKey: string): string {
  git(work, "apply", "--index", "--binary", join(store, patchKey));
  git(work, "commit", "--quiet", "-m", `${role}: task ${TASK.id}`);
  git(work, "push", "--quiet", remote, `HEAD:refs/heads/${CHANGE_ID}`);
  return git(work, "rev-parse", "HEAD").trim();
}

let base: string;

beforeAll(() => {
  expect(process.env[KEY], `${KEY} must be set (in .env.local)`).toBeTruthy();
  parent = realpathSync(mkdtempSync(join(tmpdir(), "vocab-build-e2e-")));
  work = join(parent, "work");
  remote = join(parent, "remote.git");
  store = join(parent, "store");

  // This repository at HEAD, plus the fixture change with its design and one-task plan.
  git(REPO_ROOT, "clone", "--quiet", "--no-local", REPO_ROOT, work);
  git(work, "checkout", "--quiet", "-b", CHANGE_ID);
  for (const path of ["proposal.md", "specs/vocab-import/spec.md", ".openspec.yaml"]) {
    mkdirSync(dirname(join(work, CHANGE, path)), { recursive: true });
    copyFileSync(join(FIXTURE, path), join(work, CHANGE, path));
  }
  copyFileSync(join(FIXTURE, "design-e2e.md"), join(work, CHANGE, "design.md"));
  copyFileSync(join(FIXTURE, "tasks-e2e.md"), join(work, CHANGE, "tasks.md"));
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "-m", `${CHANGE_ID}: proposal, design and plan`);
  base = git(work, "rev-parse", "HEAD").trim();
  git(parent, "clone", "--quiet", "--bare", work, remote);
  execFileSync("chmod", ["-R", "a+rX", remote]);

  // The container's factory user (uid 10001) writes the outputs.
  mkdirSync(store);
  chmodSync(store, 0o777);

  execFileSync("docker", ["build", "--platform", "linux/amd64", "--file", "factory/worker/Dockerfile", "--target", "build", "--tag", BUILD_IMAGE, "."], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
}, 900_000);

afterAll(() => {
  const roles = Object.entries(runs);
  const total = roles.reduce((sum, [, run]) => sum + run.costUsd, 0);
  console.log(
    [...roles.map(([role, run]) => `  ${role}: $${run.costUsd.toFixed(4)}, ${String(run.turns ?? "?")} turns, ${(run.wallMs / 1000).toFixed(1)} s wall`), `  total: $${total.toFixed(4)}`].join(
      "\n",
    ),
  );
  // The store holds files of the container's user: remove them from inside a container.
  if (store !== "") {
    spawnSync("docker", ["run", "--rm", "--user", "root", "--mount", `type=bind,source=${store},destination=/store`, "--entrypoint", "rm", BUILD_IMAGE, "-rf", "/store/work-items"], { stdio: "ignore" });
  }
  spawnSync("docker", ["image", "rm", "--force", BUILD_IMAGE], { stdio: "ignore" });
  if (parent !== "") rmSync(parent, { recursive: true, force: true });
});

describe("end to end in the build container", () => {
  it("the test author's outcome passes the red gate, then the implementer's passes the green gate", { timeout: 2_400_000 }, () => {
    const red = factoryBuild("test-author", base, "1");
    expect(red.status, red.output).toBe(0);
    expect(red.output).not.toContain("online-install");
    expect(red.outcome).toMatchObject({ role: "test-author", outcome: "passed", baseCommit: base, diffCheck: { passed: true, outside: [] } });
    expect(red.gates).toMatchObject({ mode: "red", passed: true });

    const next = record("test-author", red.outcome.patch);
    const changedByTests = git(work, "diff", "--name-only", base, next).split("\n").filter((path) => path !== "");
    expect(changedByTests).toContain(TASK.tests[0]);

    const green = factoryBuild("implementer", next, "1");
    expect(green.status, green.output).toBe(0);
    expect(green.outcome).toMatchObject({ role: "implementer", outcome: "passed", baseCommit: next, diffCheck: { passed: true, outside: [] } });
    expect(green.gates).toMatchObject({ mode: "green", passed: true });
    expect(green.gates?.checks.map((check) => check.name)).toEqual(["typecheck", "lint", "unit", "spec", "coverage"]);

    // The implementer left the tests as the test author wrote them.
    const final = record("implementer", green.outcome.patch);
    expect(git(work, "diff", "--name-only", next, final).split("\n").filter((path) => path !== "")).not.toContain(TASK.tests[0]);
  });
});
