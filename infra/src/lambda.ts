import { resolve } from "node:path";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

// Every Lambda of the app: Node 24 on arm64, bundled by esbuild at synth (never in Docker)
// as ESM, with its dependencies, including the AWS SDK, from the root lockfile.

export const repoRoot = resolve(import.meta.dirname, "../..");

export interface NodeFunctionProps {
  /** The handler's file, relative to the repository root. */
  readonly entry: string;
  readonly description: string;
  readonly environment?: Record<string, string>;
  readonly timeout?: Duration;
  readonly memorySize?: number;
}

export function nodeFunction(scope: Construct, id: string, props: NodeFunctionProps): NodejsFunction {
  const logGroup = new LogGroup(scope, `${id}Logs`, {
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  return new NodejsFunction(scope, id, {
    entry: resolve(repoRoot, props.entry),
    handler: "handler",
    description: props.description,
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: props.memorySize ?? 256,
    timeout: props.timeout ?? Duration.seconds(10),
    environment: props.environment ?? {},
    logGroup,
    projectRoot: repoRoot,
    depsLockFilePath: resolve(repoRoot, "pnpm-lock.yaml"),
    bundling: {
      format: OutputFormat.ESM,
      target: "node24",
      mainFields: ["module", "main"],
      // For bundled packages that still call `require`.
      banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      minify: true,
      sourceMap: false,
      forceDockerBundling: false,
      // Bundle the AWS SDK too, rather than take the runtime's, so the lockfile's versions run.
      externalModules: [],
    },
  });
}
