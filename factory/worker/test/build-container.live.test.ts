/**
 * The Bash boundaries inside the build container (add-build-roles task 2.14). Builds the worker
 * image's `build` target and runs `build-image.container.test.ts` in it, in a container started
 * with no added capabilities and Docker's default seccomp profile, in api-key mode. The container
 * gets the API key, and also the OAuth token and decoy factory and AWS credentials, so the test
 * can show that a session sees only the effective mode's credential. Values reach the container
 * through the environment only, and no value is printed. Needs Docker and ANTHROPIC_API_KEY in
 * .env.local; costs well under $0.30 in all.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { redact } from "@vocab/factory-gates";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const BUILD_IMAGE = `factory-worker-build:live-${randomBytes(4).toString("hex")}`;
const MODEL_CREDENTIALS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
/** Not real: they show that the runner's allowlist, not their absence, keeps them from a session. */
const DECOYS: Record<string, string> = {
  FACTORY_GITHUB_TOKEN: "decoy-github-token",
  AWS_SECRET_ACCESS_KEY: "decoy-aws-secret",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/decoy",
};

/** Runs Vitest in the build image; the root-owned /app gets a tmpfs for Vitest's cache only. */
function vitestInBuildImage(...args: string[]): { status: number | null; output: string } {
  const envArgs = [...MODEL_CREDENTIALS, ...Object.keys(DECOYS), "FACTORY_AUTH_MODE"].flatMap((name) => ["--env", name]);
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      ...envArgs,
      "--mount",
      "type=tmpfs,destination=/app/node_modules/.vitest-cache,tmpfs-mode=1777",
      "--workdir",
      "/app",
      "--entrypoint",
      "node_modules/.bin/vitest",
      BUILD_IMAGE,
      "run",
      "--configLoader",
      "runner",
      "--silent=false",
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"],
        ...Object.fromEntries(MODEL_CREDENTIALS.map((name) => [name, process.env[name]])),
        ...DECOYS,
        FACTORY_AUTH_MODE: "api-key",
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const secrets = MODEL_CREDENTIALS.flatMap((name) => process.env[name] ?? []);
  const output = redact(`${run.stdout}${run.stderr}`, secrets);
  console.log(output);
  return { status: run.status, output };
}

beforeAll(() => {
  for (const name of MODEL_CREDENTIALS) expect(process.env[name], `${name} must be set (in .env.local)`).toBeTruthy();
  execFileSync("docker", ["build", "--platform", "linux/amd64", "--file", "factory/worker/Dockerfile", "--target", "build", "--tag", BUILD_IMAGE, "."], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
}, 900_000);

afterAll(() => {
  spawnSync("docker", ["image", "rm", "--force", BUILD_IMAGE], { stdio: "ignore" });
});

describe("live boundaries in the build container", () => {
  it("passes the Bash boundary tests inside the build image", () => {
    const run = vitestInBuildImage("--project", "container", "factory/worker/test/build-image.container.test.ts");
    expect(run.status, run.output).toBe(0);
    // eslint-disable-next-line no-control-regex -- strips the colour codes from Vitest's summary
    const summary = /Tests\s+(.*)/.exec(run.output.replace(/\x1b\[[0-9;]*m/g, ""))?.[1] ?? "";
    expect(summary).toMatch(/(^|\s)3 passed\b/);
    expect(summary).not.toMatch(/failed|skipped/);
  });
});
