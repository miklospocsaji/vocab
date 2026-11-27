import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { base, environments } from "../config.ts";
import { checkEnvironment, isAppEnvironment } from "../src/stacks.ts";

// pnpm infra:synth --env base|test|prod [--out <dir>] (ADR 0006)
//
// Builds the web app (test and prod) and synthesises the cloud assembly, with no AWS
// credentials and no AWS calls: every child process runs with the AWS variables removed.
// Deploying is then `cdk deploy --app <dir>`, which runs no code from the repository.

const infra = resolve(import.meta.dirname, "..");
const repoRoot = resolve(infra, "..");
const bin = join(infra, "node_modules", ".bin");

export interface SynthArgs {
  readonly env: string;
  readonly out: string;
}

export function parseSynthArgs(argv: readonly string[]): SynthArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: { env: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  if (values.env === undefined) throw new Error("Usage: infra:synth --env base|test|prod [--out <dir>]");
  return { env: values.env, out: resolve(values.out ?? join(infra, "cdk.out", values.env)) };
}

/** The environment for synth's children: no AWS credentials, profile or region, and no IMDS. */
export function withoutAwsCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env))
    if (!name.startsWith("AWS_") && !name.startsWith("CDK_DEFAULT_")) clean[name] = value;
  const nowhere = join(infra, "cdk.out", "does-not-exist");
  return {
    ...clean,
    AWS_CONFIG_FILE: nowhere,
    AWS_SHARED_CREDENTIALS_FILE: nowhere,
    AWS_EC2_METADATA_DISABLED: "true",
    CDK_DISABLE_VERSION_CHECK: "1",
    CDK_DISABLE_CLI_TELEMETRY: "true",
  };
}

/** Checks the assembly reports no missing context (a lookup), and returns its stacks. */
export function checkAssembly(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    artifacts?: Record<string, { type: string; displayName?: string }>;
    missing?: { key: string }[];
  };
  const missing = manifest.missing ?? [];
  if (missing.length > 0)
    throw new Error(`The assembly reports missing context, so a lookup slipped in: ${missing.map((m) => m.key).join(", ")}`);
  return Object.entries(manifest.artifacts ?? {})
    .filter(([, artifact]) => artifact.type === "aws:cloudformation:stack")
    .map(([id, artifact]) => artifact.displayName ?? id);
}

function run(command: string, args: readonly string[], options: SpawnSyncOptions): void {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed with exit code ${String(result.status)}`);
}

function output(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export interface SynthSummary {
  readonly env: string;
  readonly commit: string;
  readonly stacks: readonly string[];
  readonly awsCdkLib: string;
}

export function synth(args: SynthArgs): SynthSummary {
  checkEnvironment(args.env, base);
  const out = args.out;
  if (relative(out, repoRoot) === "" || !relative(out, repoRoot).startsWith(".."))
    throw new Error(`Refusing to synthesise into ${out}, which holds the repository`);
  const env = withoutAwsCredentials(process.env);
  const commit = output("git", ["rev-parse", "HEAD"]);

  if (isAppEnvironment(args.env)) {
    const apiUrl = `https://${environments[args.env].api}`;
    console.error(`Building app/web with VITE_API_URL=${apiUrl}`);
    run("pnpm", ["--filter", "@vocab/web", "build"], { cwd: repoRoot, env: { ...env, VITE_API_URL: apiUrl } });
  }

  if (existsSync(out)) rmSync(out, { recursive: true });
  run(
    join(bin, "cdk"),
    [
      "synth",
      "--app",
      "node bin/app.ts",
      "-c",
      `env=${args.env}`,
      "-c",
      `commit=${commit}`,
      "--output",
      out,
      "--no-notices",
      "--quiet",
    ],
    // esbuild, for the Lambdas, comes from infra's own node_modules.
    { cwd: infra, env: { ...env, PATH: `${bin}${delimiter}${env["PATH"] ?? ""}` } },
  );

  const stacks = checkAssembly(out);
  const awsCdkLib = (
    JSON.parse(readFileSync(join(infra, "node_modules", "aws-cdk-lib", "package.json"), "utf8")) as { version: string }
  ).version;
  const summary: SynthSummary = { env: args.env, commit, stacks, awsCdkLib };
  writeFileSync(join(out, "synth.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.error(`Synthesised ${stacks.join(", ")} at ${commit} into ${out}`);
  return summary;
}

if (import.meta.main) {
  try {
    synth(parseSynthArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
