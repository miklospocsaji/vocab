/**
 * The deployed webhook rejects unsigned deliveries (add-cloud-proposal-run task 3.10). Sends
 * deliveries with no signature, a signature made with another secret and a malformed one to
 * the stack's Function URL, and checks that each gets 401 and that no execution or worker task
 * starts. It never reads the webhook secret.
 *
 * Needs the owner's AWS credentials and the deployed stack; runs only through `pnpm test:cloud`.
 * A few Lambda invocations: free at this volume.
 */
import { createHmac, randomBytes } from "node:crypto";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { ListExecutionsCommand, SFNClient } from "@aws-sdk/client-sfn";
import { describe, expect, it } from "vitest";

const REGION = "eu-central-1";
const STACK = "Factory";
/** An issue number no work item will ever have, in case a delivery were wrongly accepted. */
const ISSUE = 999_999;

interface Outputs {
  WebhookUrl: string;
  StateMachineArn: string;
  ClusterArn: string;
  WorkerTaskDefinitionArn: string;
}

async function stackOutputs(): Promise<Outputs> {
  const { Stacks } = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: STACK }));
  const found = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue])) as Partial<Outputs>;
  for (const key of ["WebhookUrl", "StateMachineArn", "ClusterArn", "WorkerTaskDefinitionArn"] as const) {
    expect(found[key], `stack ${STACK} has no output ${key}; is task 3.9 deployed?`).toBeTruthy();
  }
  return found as Outputs;
}

async function executions(stateMachineArn: string): Promise<string[]> {
  const { executions: list } = await new SFNClient({ region: REGION }).send(new ListExecutionsCommand({ stateMachineArn, maxResults: 100 }));
  return (list ?? []).map((execution) => execution.executionArn ?? "");
}

/**
 * The worker's tasks in the cluster, running or stopped: the only tasks the webhook can start.
 * Other tasks, such as the boundary check's in a parallel cloud test, are not counted.
 */
async function workerTasks(cluster: string, workerTaskDefinitionArn: string): Promise<string[]> {
  const family = /:task-definition\/([^:]+):\d+$/.exec(workerTaskDefinitionArn)?.[1];
  expect(family, `no family in ${workerTaskDefinitionArn}`).toBeTruthy();
  const ecs = new ECSClient({ region: REGION });
  const running = await ecs.send(new ListTasksCommand({ cluster, family, desiredStatus: "RUNNING" }));
  const stopped = await ecs.send(new ListTasksCommand({ cluster, family, desiredStatus: "STOPPED" }));
  return [...(running.taskArns ?? []), ...(stopped.taskArns ?? [])];
}

describe("deployed webhook", () => {
  it("Scenario: Unsigned webhook is rejected", async () => {
    const outputs = await stackOutputs();
    const executionsBefore = await executions(outputs.StateMachineArn);
    const tasksBefore = await workerTasks(outputs.ClusterArn, outputs.WorkerTaskDefinitionArn);

    const body = JSON.stringify({
      action: "labeled",
      label: { name: "factory" },
      issue: { number: ISSUE, state: "open", title: "cloud test" },
      repository: { full_name: "miklospocsaji/vocab" },
    });
    const otherSecret = randomBytes(32).toString("hex");
    const signatures: (string | undefined)[] = [
      undefined,
      `sha256=${createHmac("sha256", otherSecret).update(body).digest("hex")}`,
      "sha256=not-a-signature",
    ];
    for (const signature of signatures) {
      const response = await fetch(outputs.WebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": `cloud-test-${randomBytes(8).toString("hex")}`,
          ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
        },
        body,
      });
      expect(response.status, `signature ${signature ?? "(none)"}`).toBe(401);
    }

    // Nothing started: no execution, and no worker task.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await executions(outputs.StateMachineArn)).toEqual(executionsBefore);
    expect((await workerTasks(outputs.ClusterArn, outputs.WorkerTaskDefinitionArn)).filter((task) => !tasksBefore.includes(task))).toEqual([]);
  });
});
