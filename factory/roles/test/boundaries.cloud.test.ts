/**
 * The role boundaries on Fargate (add-cloud-proposal-run task 2.7). Runs the stack's
 * boundary-check task definition as one-off Fargate task, in api-key mode, with a command
 * override that runs the live boundary tests and the Bash-free unit test inside it.
 *
 * The check image is the worker image plus Vitest (owner decision, 2026-11-06; ADR 0010). Before
 * anything runs, this test checks against the deployed stack that the check stands for the
 * worker: the two task definitions are the same in everything but the image, and every layer
 * of the deployed worker image is, in order, a layer of the check image.
 *
 * It also runs `bwrap` in the task and prints whether it starts, as input to M3; that result
 * never fails the test. Needs the owner's AWS credentials and the deployed stack; runs only
 * through `pnpm test:cloud`. A few Fargate minutes and under $0.10 of Haiku.
 */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { BatchGetImageCommand, ECRClient } from "@aws-sdk/client-ecr";
import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  waitUntilTasksStopped,
  type ContainerDefinition,
  type TaskDefinition,
} from "@aws-sdk/client-ecs";
import { beforeAll, describe, expect, it } from "vitest";

const REGION = "eu-central-1";
const STACK = "Factory";
/** The live tests' per-file budget for this run. */
const MAX_COST_USD = 0.1;

const LIVE_TESTS = [
  "Write outside the allowed paths is denied",
  "Reading a process environment is denied",
  "WebFetch outside GitHub is denied",
];
const UNIT_TEST = "Proposal author cannot run commands";

/** Runs in the task's container; prints markers the test reads back from the task's log. */
const SCRIPT = [
  // Whether bubblewrap can create its namespaces here: input to M3, never a failure.
  "if bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all true 2>/tmp/bwrap.err; then echo 'BWRAP: started';",
  "else echo \"BWRAP: failed: $(head -c 300 /tmp/bwrap.err | tr '\\n' ' ')\"; fi",
  `node_modules/.bin/vitest run --configLoader runner --silent=false --project live factory/roles/test/boundaries.live.test.ts --testNamePattern 'Scenario: (${LIVE_TESTS.join("|")})$'`,
  "live=$?",
  `node_modules/.bin/vitest run --configLoader runner --project unit factory/roles/test/proposal-author.test.ts --testNamePattern 'Scenario: ${UNIT_TEST}$'`,
  "unit=$?",
  'echo "EXIT: live=$live unit=$unit"',
  '[ "$live" -eq 0 ] && [ "$unit" -eq 0 ]',
].join("\n");

interface StackOutputs {
  ClusterArn: string;
  WorkerTaskDefinitionArn: string;
  BoundaryCheckTaskDefinitionArn: string;
  WorkerContainerName: string;
  WorkerSubnetIds: string;
  WorkerSecurityGroupId: string;
  WorkerLogGroupName: string;
}

const ecs = new ECSClient({ region: REGION });
const ecr = new ECRClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });
let outputs: StackOutputs;

async function stackOutputs(): Promise<StackOutputs> {
  const { Stacks } = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: STACK }));
  const entries = (Stacks?.[0]?.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]);
  const found = Object.fromEntries(entries) as Partial<StackOutputs>;
  for (const key of ["ClusterArn", "WorkerTaskDefinitionArn", "BoundaryCheckTaskDefinitionArn", "WorkerContainerName", "WorkerSubnetIds", "WorkerSecurityGroupId", "WorkerLogGroupName"] as const) {
    expect(found[key], `stack ${STACK} has no output ${key}; is it deployed?`).toBeTruthy();
  }
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

/** What makes two task definitions run alike: everything but identity, revision and image. */
function comparable(definition: TaskDefinition): unknown {
  const identity = new Set(["taskDefinitionArn", "family", "revision", "registeredAt", "registeredBy", "containerDefinitions"]);
  // Lists AWS computes, such as compatibilities, come back in no particular order.
  const unordered = new Set(["compatibilities", "requiresAttributes", "requiresCompatibilities"]);
  const rest = Object.fromEntries(
    Object.entries(definition)
      .filter(([key]) => !identity.has(key))
      .map(([key, value]) => [key, unordered.has(key) && Array.isArray(value) ? value.map((item) => JSON.stringify(item)).sort() : value]),
  );
  const containers = (definition.containerDefinitions ?? []).map((container) => Object.fromEntries(Object.entries(container).filter(([key]) => key !== "image")));
  return { ...rest, containerDefinitions: containers };
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

interface Manifest {
  manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[];
  layers?: { digest: string }[];
}

/** The layer digests of an image in ECR, for linux/amd64 if the image is an index. */
async function layers(imageUri: string): Promise<string[]> {
  const match = /^[^/]+\/([^:@]+)(?::([^@]+))?(?:@(.+))?$/.exec(imageUri);
  const [, repositoryName, imageTag, imageDigest] = match ?? [];
  if (repositoryName === undefined) throw new Error(`not an ECR image URI: ${imageUri}`);
  const get = async (id: { imageTag?: string; imageDigest?: string }): Promise<Manifest> => {
    const { images } = await ecr.send(new BatchGetImageCommand({ repositoryName, imageIds: [id], acceptedMediaTypes: MANIFEST_TYPES }));
    const manifest = images?.[0]?.imageManifest;
    if (manifest === undefined) throw new Error(`no manifest for ${imageUri}`);
    return JSON.parse(manifest) as Manifest;
  };
  let manifest = await get(imageDigest === undefined ? { imageTag: imageTag ?? "latest" } : { imageDigest });
  if (manifest.manifests !== undefined) {
    const amd64 = manifest.manifests.find((entry) => entry.platform?.os === "linux" && entry.platform.architecture === "amd64");
    if (amd64 === undefined) throw new Error(`no linux/amd64 image in ${imageUri}`);
    manifest = await get({ imageDigest: amd64.digest });
  }
  return (manifest.layers ?? []).map((layer) => layer.digest);
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

/** Vitest's summary lines, in order, colour codes removed. */
function summaries(output: string): string[] {
  // eslint-disable-next-line no-control-regex -- strips the colour codes from Vitest's output
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  return Array.from(plain.matchAll(/^\s*Tests\s+(.*)$/gm), (match) => match[1] ?? "");
}

beforeAll(async () => {
  outputs = await stackOutputs();
});

describe("role boundaries on Fargate", () => {
  it("runs a boundary check that stands for the deployed worker", async () => {
    const worker = await taskDefinition(outputs.WorkerTaskDefinitionArn);
    const check = await taskDefinition(outputs.BoundaryCheckTaskDefinitionArn);

    // Same roles, secrets, environment, size, platform and logs: only the image differs.
    expect(comparable(check)).toEqual(comparable(worker));
    expect(worker.requiresCompatibilities).toEqual(["FARGATE"]);
    expect(onlyContainer(check).environment).toContainEqual({ name: "FACTORY_AUTH_MODE", value: "api-key" });

    // The check image is the worker image with layers added on top, none changed or removed.
    const workerLayers = await layers(onlyContainer(worker).image ?? "");
    const checkLayers = await layers(onlyContainer(check).image ?? "");
    expect(workerLayers.length).toBeGreaterThan(0);
    expect(checkLayers.slice(0, workerLayers.length)).toEqual(workerLayers);
    expect(checkLayers.length).toBeGreaterThan(workerLayers.length);
  });

  it("Scenario: Boundaries hold in Fargate", async () => {
    const container = outputs.WorkerContainerName;
    const { tasks, failures } = await ecs.send(
      new RunTaskCommand({
        cluster: outputs.ClusterArn,
        taskDefinition: outputs.BoundaryCheckTaskDefinitionArn,
        launchType: "FARGATE",
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: { subnets: outputs.WorkerSubnetIds.split(","), securityGroups: [outputs.WorkerSecurityGroupId], assignPublicIp: "ENABLED" },
        },
        overrides: { containerOverrides: [{ name: container, command: ["sh", "-c", SCRIPT] }] },
      }),
    );
    expect(failures ?? []).toEqual([]);
    const taskArn = tasks?.[0]?.taskArn;
    if (taskArn === undefined) throw new Error("no task started");

    await waitUntilTasksStopped({ client: ecs, maxWaitTime: 1_200, minDelay: 15, maxDelay: 30 }, { cluster: outputs.ClusterArn, tasks: [taskArn] });
    const stopped = (await ecs.send(new DescribeTasksCommand({ cluster: outputs.ClusterArn, tasks: [taskArn] }))).tasks?.[0];
    const exitCode = stopped?.containers?.find((entry) => entry.name === container)?.exitCode;

    // awslogs streams are <prefix>/<container>/<task id>.
    const taskId = taskArn.split("/").at(-1) ?? "";
    const output = await logText(outputs.WorkerLogGroupName, `worker/${container}/${taskId}`).catch(() => "");
    console.log(output.split("\n").filter((line) => /^(BWRAP|EXIT):|total: \$/.test(line.trim())).join("\n"));

    expect(exitCode, `task stopped: ${stopped?.stoppedReason ?? "unknown"}; output:\n${output}`).toBe(0);
    expect(output).toContain("EXIT: live=0 unit=0");
    const [live, unit] = summaries(output);
    expect(live).toMatch(new RegExp(`(^|\\s)${String(LIVE_TESTS.length)} passed\\b`));
    expect(live).not.toMatch(/failed/);
    expect(unit).toMatch(/(^|\s)1 passed\b/);
    expect(unit).not.toMatch(/failed/);

    // api-key mode, within budget, and no credential in the task's log.
    const cost = Number(/total: \$([0-9.]+)/.exec(output)?.[1] ?? Number.NaN);
    expect(cost).toBeLessThan(MAX_COST_USD);
    expect(output).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8,}/);
    expect(output).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(output).not.toMatch(/"password"\s*:/);
  });
});
