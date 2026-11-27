import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deployCommand, parseDeployArgs } from "../scripts/deploy.ts";
import { checkAssembly, parseSynthArgs, withoutAwsCredentials } from "../scripts/synth.ts";

const infra = resolve(import.meta.dirname, "..");

function assemblyWith(manifest: object): string {
  const dir = mkdtempSync(join(tmpdir(), "vocab-assembly-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

describe("infra:synth", () => {
  it("Scenario: Synth refuses an unknown environment", () => {
    const run = spawnSync(process.execPath, ["scripts/synth.ts", "--env", "stage"], { cwd: infra, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Unknown environment "stage"');
  });

  it("Scenario: Synth needs an environment", () => {
    expect(() => parseSynthArgs([])).toThrow(/--env/);
    expect(parseSynthArgs(["--env", "base"])).toEqual({ env: "base", out: resolve(infra, "cdk.out/base") });
    expect(parseSynthArgs(["--env", "test", "--out", "/tmp/x"])).toEqual({ env: "test", out: "/tmp/x" });
  });

  it("Scenario: Synth fails on missing context", () => {
    const dir = assemblyWith({
      version: "1",
      artifacts: {},
      missing: [{ key: "availability-zones:account=1:region=eu-central-1", provider: "availability-zones", props: {} }],
    });
    expect(() => checkAssembly(dir)).toThrow(/availability-zones:account=1:region=eu-central-1/);
  });

  it("Scenario: Synth lists the stacks of a complete assembly", () => {
    const dir = assemblyWith({
      version: "1",
      artifacts: {
        VocabZone: { type: "aws:cloudformation:stack" },
        "Tree": { type: "cdk:tree" },
      },
    });
    expect(checkAssembly(dir)).toEqual(["VocabZone"]);
  });

  it("Scenario: Synth runs its children without AWS credentials", () => {
    const env = withoutAwsCredentials({
      PATH: "/bin",
      HOME: "/home/someone",
      AWS_PROFILE: "vocab-app",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "eu-central-1",
      CDK_DEFAULT_ACCOUNT: "100159507559",
    });
    expect(env["PATH"]).toBe("/bin");
    expect(env["HOME"]).toBe("/home/someone");
    for (const name of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "CDK_DEFAULT_ACCOUNT"])
      expect(env[name]).toBeUndefined();
    expect(env["AWS_EC2_METADATA_DISABLED"]).toBe("true");
    expect(env["AWS_CONFIG_FILE"]).toMatch(/does-not-exist/);
    expect(env["AWS_SHARED_CREDENTIALS_FILE"]).toMatch(/does-not-exist/);
  });
});

describe("infra:deploy", () => {
  it("Scenario: Deploy deploys every stack of the assembly by default", () => {
    const args = parseDeployArgs(["--env", "test"]);
    expect(deployCommand(args, "/repo/infra/cdk.out/test")).toEqual([
      "deploy",
      "--app",
      "/repo/infra/cdk.out/test",
      "--all",
      "--require-approval",
      "broadening",
      "--outputs-file",
      "/repo/infra/cdk.out/test-outputs.json",
    ]);
  });

  it("Scenario: Deploy with --stack deploys just that stack", () => {
    const args = parseDeployArgs(["--env", "base", "--stack", "VocabZone"]);
    expect(deployCommand(args, "/o/base")).toEqual([
      "deploy",
      "--app",
      "/o/base",
      "VocabZone",
      "--require-approval",
      "broadening",
      "--outputs-file",
      "/o/base-outputs.json",
    ]);
  });

  it("Scenario: Deploy refuses an unknown environment", () => {
    expect(() => parseDeployArgs(["--env", "stage"])).toThrow(/Unknown environment "stage"/);
  });
});
