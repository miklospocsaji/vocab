import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { environmentNames } from "../src/stacks.ts";
import { synth } from "./synth.ts";

// pnpm infra:deploy --env base|test|prod [--stack <name>] (ADR 0006)
//
// The owner's command for deploys by hand, with AWS_PROFILE=vocab-app: synthesises into
// infra/cdk.out/<env> with no credentials, then deploys that assembly. The deploy pipeline
// does not use it; it runs its own `cdk deploy --app <dir>`.

const infra = resolve(import.meta.dirname, "..");

export interface DeployArgs {
  readonly env: string;
  readonly stack?: string;
}

export function parseDeployArgs(argv: readonly string[]): DeployArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: { env: { type: "string" }, stack: { type: "string" } },
    strict: true,
  });
  if (values.env === undefined) throw new Error("Usage: infra:deploy --env base|test|prod [--stack <name>]");
  if (!(environmentNames as readonly string[]).includes(values.env))
    throw new Error(`Unknown environment "${values.env}": expected ${environmentNames.join(", ")}`);
  return values.stack === undefined ? { env: values.env } : { env: values.env, stack: values.stack };
}

/** The `cdk` arguments that deploy the assembly at `out`. */
export function deployCommand(args: DeployArgs, out: string): string[] {
  return [
    "deploy",
    "--app",
    out,
    args.stack ?? "--all",
    "--require-approval",
    "broadening",
    "--outputs-file",
    `${out}-outputs.json`,
  ];
}

if (import.meta.main) {
  try {
    const args = parseDeployArgs(process.argv.slice(2));
    const out = join(infra, "cdk.out", args.env);
    synth({ env: args.env, out });
    const result = spawnSync(join(infra, "node_modules", ".bin", "cdk"), deployCommand(args, out), {
      cwd: infra,
      stdio: "inherit",
      env: { ...process.env, CDK_DISABLE_VERSION_CHECK: "1", CDK_DISABLE_CLI_TELEMETRY: "true" },
    });
    if (result.error !== undefined) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
