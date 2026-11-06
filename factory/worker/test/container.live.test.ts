/**
 * The role boundaries inside the factory-worker image (add-factory-worker task 1.16). Builds
 * the image, adds Vitest on top (live-check.Dockerfile), and runs the boundary tests in a
 * container started with no added capabilities and Docker's default seccomp profile, in
 * subscription mode. The OAuth token reaches the container through the environment only.
 * Needs Docker; costs well under $0.10 in all.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const TAG = randomBytes(4).toString("hex");
const WORKER_IMAGE = `factory-worker:live-${TAG}`;
const CHECK_IMAGE = `factory-worker-live-check:${TAG}`;
const TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

function docker(...args: string[]): void {
  execFileSync("docker", args, { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

interface Run {
  status: number | null;
  output: string;
}

/** Runs a command in the live-check image: no added capabilities, the token by name only. */
function inContainer(...command: string[]): Run {
  const run = spawnSync("docker", ["run", "--rm", "--env", TOKEN_VAR, CHECK_IMAGE, ...command], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], [TOKEN_VAR]: process.env[TOKEN_VAR] },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout}${run.stderr}`;
  console.log(output);
  return { status: run.status, output };
}

function vitest(...args: string[]): Run {
  return inContainer("node_modules/.bin/vitest", "run", "--configLoader", "runner", "--silent=false", ...args);
}

/** Vitest's summary: exactly `n` tests passed and none failed (those the filter left out count as skipped). */
function expectPassed(run: Run, n: number): void {
  expect(run.status, run.output).toBe(0);
  // eslint-disable-next-line no-control-regex -- strips the colour codes from Vitest's summary
  const plain = run.output.replace(/\x1b\[[0-9;]*m/g, "");
  const summary = /Tests\s+(.*)/.exec(plain)?.[1] ?? "";
  expect(summary).toMatch(new RegExp(`(^|\\s)${String(n)} passed\\b`));
  expect(summary).not.toMatch(/failed/);
}

beforeAll(() => {
  expect(process.env[TOKEN_VAR], `${TOKEN_VAR} must be set (in .env.local)`).toBeTruthy();
  docker("build", "--platform", "linux/amd64", "--file", "factory/worker/Dockerfile", "--tag", WORKER_IMAGE, ".");
  docker("build", "--file", "factory/worker/test/live-check.Dockerfile", "--build-arg", `WORKER_IMAGE=${WORKER_IMAGE}`, "--tag", CHECK_IMAGE, ".");
}, 900_000);

afterAll(() => {
  spawnSync("docker", ["image", "rm", "--force", CHECK_IMAGE, WORKER_IMAGE], { stdio: "ignore" });
});

describe("live boundaries in the factory-worker container", () => {
  it("Scenario: Boundaries hold in the worker container", () => {
    const live = vitest(
      "--project",
      "live",
      "factory/roles/test/boundaries.live.test.ts",
      "--testNamePattern",
      "Scenario: (Write outside the allowed paths is denied|Reading a process environment is denied|WebFetch outside GitHub is denied)$",
    );
    expectPassed(live, 3);

    const config = vitest("--project", "unit", "factory/roles/test/proposal-author.test.ts", "--testNamePattern", "Scenario: Proposal author cannot run commands$");
    expectPassed(config, 1);
  });

  it("Scenario: Missing sandbox blocks Bash", () => {
    // bubblewrap is in the image (ADR 0010), so only the namespaces it cannot create stop it.
    expect(inContainer("sh", "-c", "command -v bwrap").output.trim()).toBe("/usr/bin/bwrap");

    expectPassed(vitest("--project", "container", "--testNamePattern", "Scenario: Missing sandbox blocks Bash$"), 1);
  });

  it("runs the Grep tool in the image without a system ripgrep", () => {
    expect(inContainer("sh", "-c", "command -v rg || echo none").output.trim()).toBe("none");
    expectPassed(vitest("--project", "container", "--testNamePattern", "runs the Grep tool without a system ripgrep$"), 1);
  });
});
