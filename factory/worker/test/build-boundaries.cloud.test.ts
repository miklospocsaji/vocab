/**
 * The build container's boundaries on Fargate (add-build-loop task 4.8). Two one-off Fargate tasks
 * against the deployed stack, in api-key mode:
 * - The stack's build task definition itself, as the Build state runs it, with a decoy factory
 *   credential in its environment: `factory-build` must refuse to start, naming the variable and
 *   never its value. No session runs, so this costs no model budget.
 * - The test-only build boundary check, which is the build task definition with an `sh -c` entry
 *   point, since ECS overrides a container's command but never its entry point (owner decision,
 *   2026-11-13; ADR 0010's boundary check is the precedent). It runs the live Bash boundary tests
 *   of `build-image.container.test.ts` with Vitest from the image's dev dependencies, with decoy
 *   `CLAUDE_CODE_OAUTH_TOKEN`, `FACTORY_GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY` in its
 *   environment (ECS sets `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` itself), none of which the
 *   session may see.
 *
 * Before anything runs, it checks against the deployed stack that the check stands for the build
 * task: the two task definitions are the same in everything but their family, entry point and
 * command, and they run the same image. Needs the owner's AWS credentials and the deployed stack;
 * runs only through `pnpm test:cloud`. A few Fargate minutes and under $0.10 of Haiku.
 */
import { randomBytes } from "node:crypto";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  waitUntilTasksStopped,
  type ContainerDefinition,
  type ContainerOverride,
  type TaskDefinition,
} from "@aws-sdk/client-ecs";
import { beforeAll, describe, expect, it } from "vitest";

const REGION = "eu-central-1";
const STACK = "Factory";
/** The live tests' budget for this run. */
const MAX_COST_USD = 0.1;
/** A change and task no plan has: the refusal comes before the store is read. */
const PROBE_CHANGE = "add-boundary-probe";

const LIVE_TESTS = ["Non-allowlisted command is denied", "Build container holds only the model credential"];

/**
 * Runs in the check's container from `/app`. Vitest's caches go to /tmp: `/app` is root-owned,
 * and Fargate has no tmpfs for them.
 */
const SCRIPT = [
  "cd /app",
  [
    "node_modules/.bin/vitest run --configLoader runner --silent=false --no-cache --fsModuleCachePath /tmp/vitest-cache",
    "--project container factory/worker/test/build-image.container.test.ts",
    `--testNamePattern 'Scenario: (${LIVE_TESTS.join("|")})$'`,
  ].join(" "),
  "code=$?",
  'echo "EXIT: container=$code"',
  "exit $code",
].join("\n");

interface StackOutputs {
  ClusterArn: string;
  BuildTaskDefinitionArn: string;
  BuildBoundaryCheckTaskDefinitionArn: string;
  BuildContainerName: string;
  BuildSecurityGroupId: string;
  WorkerSubnetIds: string;
  WorkerLogGroupName: string;
}
const OUTPUT_KEYS = [
  "ClusterArn",
  "BuildTaskDefinitionArn",
  "BuildBoundaryCheckTaskDefinitionArn",
  "BuildContainerName",
  "BuildSecurityGroupId",
  "WorkerSubnetIds",
  "WorkerLogGroupName",
] as const;

const ecs = new ECSClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });
let outputs: StackOutputs;

async function stackOutputs(): Promise<StackOutputs> {
  const { Stacks } = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: STACK }));
  const entries = (Stacks?.[0]?.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]);
  const found = Object.fromEntries(entries) as Partial<StackOutputs>;
  for (const key of OUTPUT_KEYS) expect(found[key], `stack ${STACK} has no output ${key}; is it deployed?`).toBeTruthy();
  return found as StackOutputs;
}

async function taskDefinition(arn: string): Promise<TaskDefinition> {
  const { taskDefinition: definition } = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
  if (definition === undefined) throw new Error(`no task definition ${arn}`);
  return definition;
}

function onlyContainer(definition: TaskDefinition): ContainerDefinition {
  expect(definition.containerDefinitions).toHaveLength(1);
  const [container] = definition.containerDefinitions ?? [];
  if (container === undefined) throw new Error("no container");
  return container;
}

/** What makes the two task definitions run alike: everything but identity, revision, entry point and command. */
function comparable(definition: TaskDefinition): unknown {
  const identity = new Set(["taskDefinitionArn", "family", "revision", "registeredAt", "registeredBy", "containerDefinitions"]);
  // Lists AWS computes, such as compatibilities, come back in no particular order.
  const unordered = new Set(["compatibilities", "requiresAttributes", "requiresCompatibilities"]);
  const rest = Object.fromEntries(
    Object.entries(definition)
      .filter(([key]) => !identity.has(key))
      .map(([key, value]) => [key, unordered.has(key) && Array.isArray(value) ? value.map((item) => JSON.stringify(item)).sort() : value]),
  );
  const containers = (definition.containerDefinitions ?? []).map((container) =>
    Object.fromEntries(Object.entries(container).filter(([key]) => key !== "entryPoint" && key !== "command")),
  );
  return { ...rest, containerDefinitions: containers };
}

/** Every event of a log stream, in order. */
async function logText(group: string, stream: string): Promise<string> {
  const lines: string[] = [];
  let token: string | undefined;
  for (;;) {
    const page = await logs.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startFromHead: true, ...(token === undefined ? {} : { nextToken: token }) }));
    lines.push(...(page.events ?? []).map((event) => event.message ?? ""));
    if (page.nextForwardToken === undefined || page.nextForwardToken === token) break;
    token = page.nextForwardToken;
  }
  return lines.join("\n");
}

/** Runs one task of a task definition in the build security group, waits for it, and returns its exit code and log. */
async function runToEnd(taskDefinitionArn: string, override: Omit<ContainerOverride, "name">): Promise<{ exitCode: number | undefined; reason: string; output: string }> {
  const container = outputs.BuildContainerName;
  const { tasks, failures } = await ecs.send(
    new RunTaskCommand({
      cluster: outputs.ClusterArn,
      taskDefinition: taskDefinitionArn,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: { subnets: outputs.WorkerSubnetIds.split(","), securityGroups: [outputs.BuildSecurityGroupId], assignPublicIp: "ENABLED" },
      },
      overrides: { containerOverrides: [{ name: container, ...override }] },
    }),
  );
  expect(failures ?? []).toEqual([]);
  const taskArn = tasks?.[0]?.taskArn;
  if (taskArn === undefined) throw new Error("no task started");

  await waitUntilTasksStopped({ client: ecs, maxWaitTime: 1_200, minDelay: 15, maxDelay: 30 }, { cluster: outputs.ClusterArn, tasks: [taskArn] });
  const stopped = (await ecs.send(new DescribeTasksCommand({ cluster: outputs.ClusterArn, tasks: [taskArn] }))).tasks?.[0];
  const exitCode = stopped?.containers?.find((entry) => entry.name === container)?.exitCode;
  // awslogs streams are <prefix>/<container>/<task id>; the build task logs with the prefix `build`.
  const taskId = taskArn.split("/").at(-1) ?? "";
  const output = await logText(outputs.WorkerLogGroupName, `build/${container}/${taskId}`).catch(() => "");
  return { exitCode, reason: stopped?.stoppedReason ?? "unknown", output };
}

/** Vitest's summary lines, in order, colour codes removed. */
function summaries(output: string): string[] {
  // eslint-disable-next-line no-control-regex -- strips the colour codes from Vitest's output
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  return Array.from(plain.matchAll(/^\s*Tests\s+(.*)$/gm), (match) => match[1] ?? "");
}

/** No credential's value in a task's log. */
function expectNoCredential(output: string): void {
  expect(output).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8,}/);
  expect(output).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  expect(output).not.toMatch(/"password"\s*:/);
  expect(output).not.toMatch(/\bgh[sopu]_[A-Za-z0-9]{20,}/);
}

beforeAll(async () => {
  outputs = await stackOutputs();
});

describe("build boundaries on Fargate", () => {
  it("runs a boundary check that stands for the deployed build task", async () => {
    const build = await taskDefinition(outputs.BuildTaskDefinitionArn);
    const check = await taskDefinition(outputs.BuildBoundaryCheckTaskDefinitionArn);

    // Same roles, secret, environment, size, storage, platform, logs and image.
    expect(comparable(check)).toEqual(comparable(build));
    expect(onlyContainer(check).image).toBe(onlyContainer(build).image);
    expect(build.requiresCompatibilities).toEqual(["FARGATE"]);
    expect(onlyContainer(build).environment).toContainEqual({ name: "FACTORY_AUTH_MODE", value: "api-key" });
    expect((onlyContainer(build).secrets ?? []).map((secret) => secret.name)).toEqual(["ANTHROPIC_API_KEY"]);
    // The build task keeps the image's factory-build entry point; only the check replaces it.
    expect(onlyContainer(build).entryPoint ?? []).toEqual([]);
    expect(onlyContainer(check).entryPoint).toEqual(["sh", "-c"]);
  });

  it("Scenario: Build boundaries hold in Fargate", async () => {
    // Build container refuses factory credentials: the real build task definition, as the Build
    // state starts it, with a decoy ledger secret. It exits 2 naming the variable, not its value.
    const decoy = `decoy-${randomBytes(12).toString("hex")}`;
    const refused = await runToEnd(outputs.BuildTaskDefinitionArn, {
      command: ["build", "--change", PROBE_CHANGE, "--task", "1.1"],
      environment: [{ name: "FACTORY_LEDGER_SECRET", value: decoy }],
    });
    console.log(refused.output);
    expect(refused.exitCode, `task stopped: ${refused.reason}; output:\n${refused.output}`).toBe(2);
    expect(refused.output).toContain("FACTORY_LEDGER_SECRET");
    expect(refused.output).not.toContain(decoy);
    expectNoCredential(refused.output);

    // Non-allowlisted command is denied, and Build container holds only the model credential:
    // the live tests, in the check of the same image, roles and environment.
    // The decoys the live test needs in the container; it checks the session sees none of them.
    // ECS sets AWS_CONTAINER_CREDENTIALS_RELATIVE_URI itself, for the task role.
    const decoys = ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"].map((name) => ({
      name,
      value: `decoy-${randomBytes(12).toString("hex")}`,
    }));
    const live = await runToEnd(outputs.BuildBoundaryCheckTaskDefinitionArn, { command: [SCRIPT], environment: decoys });
    console.log(live.output.split("\n").filter((line) => /^(EXIT):|total: \$|✓|×/.test(line.trim())).join("\n"));

    expect(live.exitCode, `task stopped: ${live.reason}; output:\n${live.output}`).toBe(0);
    expect(live.output).toContain("EXIT: container=0");
    const [summary] = summaries(live.output);
    expect(summary).toMatch(new RegExp(`(^|\\s)${String(LIVE_TESTS.length)} passed\\b`));
    expect(summary).not.toMatch(/failed/);

    // api-key mode, within budget, and no credential in the task's log.
    const cost = Number(/total: \$([0-9.]+)/.exec(live.output)?.[1] ?? Number.NaN);
    expect(cost).toBeLessThan(MAX_COST_USD);
    expectNoCredential(live.output);
    for (const { value } of decoys) expect(live.output).not.toContain(value);
  });
});
