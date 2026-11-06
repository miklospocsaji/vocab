/**
 * The work item's state machine (add-cloud-proposal-run task 3.2): `definition()` is pure ASL,
 * run here by the simulator in asl-simulator.ts with the real JSONata library and scripted
 * worker outcomes, shaped as the spike of task 3.1 measured them. No AWS.
 */
import { describe, expect, it } from "vitest";
import { definition, type WorkerTaskConfig } from "../src/state-machine.ts";
import { RUN_TASK_SYNC, RUN_TASK_WAIT_FOR_TOKEN, simulate, type Simulation, type TaskCall, type TaskOutcome } from "./asl-simulator.ts";

const CONFIG: WorkerTaskConfig = {
  cluster: "arn:aws:ecs:eu-central-1:123456789012:cluster/factory",
  taskDefinition: "arn:aws:ecs:eu-central-1:123456789012:task-definition/FactoryWorker:7",
  subnets: ["subnet-0aaa", "subnet-0bbb"],
  securityGroup: "sg-0worker",
  container: "worker",
};
const EXECUTION = "arn:aws:states:eu-central-1:123456789012:execution:factory-work-item:issue-12-5f0c";
const ISSUE = 12;
const INPUT = { issueNumber: ISSUE };

/** The worker's states, as their command's first word. */
type WorkerState = "intake" | "proposal" | "await-approval" | "approved" | "escalate";

/**
 * Runs the definition with each worker state's outcomes, in order. A state with no outcome left
 * exits 0 (`.sync`) or is approved (`.waitForTaskToken`).
 */
async function run(script: Partial<Record<WorkerState, TaskOutcome[]>> = {}): Promise<Simulation> {
  const queues = Object.fromEntries(Object.entries(script).map(([state, outcomes]) => [state, [...outcomes]])) as Partial<Record<string, TaskOutcome[]>>;
  return simulate(definition(CONFIG), INPUT, {
    executionArn: EXECUTION,
    onTask: (call: TaskCall) => {
      const next = queues[call.command[0] ?? ""]?.shift();
      if (next !== undefined) return next;
      return call.resource === RUN_TASK_WAIT_FOR_TOKEN ? { success: {} } : { exit: 0 };
    },
  });
}

const issue = ["--issue", String(ISSUE)];
const commands = (simulation: Simulation) => simulation.tasks.map((task) => task.command);
const crashes: [string, TaskOutcome][] = [
  ["exits 1", { exit: 1 }],
  ["never starts", { notStarted: true }],
  ["cannot be run", { ecsError: "Rate exceeded (Service: AmazonECS; Status Code: 400; Error Code: ThrottlingException)" }],
];

describe("state machine definition", () => {
  it("uses JSONata for the whole definition", () => {
    const asl = definition(CONFIG) as { QueryLanguage?: unknown; States: Record<string, Record<string, unknown>> };

    expect(asl.QueryLanguage).toBe("JSONata");
    for (const [name, state] of Object.entries(asl.States)) {
      expect(state["QueryLanguage"] ?? "JSONata", name).toBe("JSONata");
      for (const field of ["Parameters", "InputPath", "OutputPath", "ResultPath", "ResultSelector"]) expect(state, name).not.toHaveProperty(field);
    }
    // The definition is plain JSON: CDK serialises it with its tokens.
    expect(JSON.parse(JSON.stringify(asl))).toEqual(asl);
  });

  it("runs Intake, Proposal, AwaitApproval and Approved in order, then succeeds", async () => {
    const simulation = await run();

    expect(simulation.status).toBe("SUCCEEDED");
    expect(commands(simulation)).toEqual([
      ["intake", ...issue, "--execution", EXECUTION],
      ["proposal", ...issue],
      ["await-approval", ...issue],
      ["approved", ...issue],
    ]);
    expect(simulation.tasks.map((task) => task.resource)).toEqual([RUN_TASK_SYNC, RUN_TASK_SYNC, RUN_TASK_WAIT_FOR_TOKEN, RUN_TASK_SYNC]);
    expect(simulation.waits).toEqual([]);
  });

  it("runs every task as the worker on Fargate, in the public subnets with a public IP", async () => {
    const simulation = await run({ proposal: [{ exit: 1 }, { exit: 1 }, { exit: 1 }] });

    expect(simulation.tasks.length).toBeGreaterThan(4);
    for (const task of simulation.tasks) {
      expect(task.arguments).toMatchObject({
        Cluster: CONFIG.cluster,
        TaskDefinition: CONFIG.taskDefinition,
        LaunchType: "FARGATE",
        NetworkConfiguration: { AwsvpcConfiguration: { Subnets: CONFIG.subnets, SecurityGroups: [CONFIG.securityGroup], AssignPublicIp: "ENABLED" } },
      });
      const overrides = (task.arguments["Overrides"] as { ContainerOverrides: Record<string, unknown>[] }).ContainerOverrides;
      expect(overrides).toHaveLength(1);
      expect(overrides[0]?.["Name"]).toBe(CONFIG.container);
    }
  });

  it("passes AwaitApproval's task token to the worker as FACTORY_TASK_TOKEN, and only there", async () => {
    const simulation = await run();

    const awaiting = simulation.tasks.filter((task) => task.resource === RUN_TASK_WAIT_FOR_TOKEN);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]?.taskToken).toBeTruthy();
    expect(awaiting[0]?.environment).toEqual({ FACTORY_TASK_TOKEN: awaiting[0]?.taskToken });
    for (const task of simulation.tasks.filter((t) => t.resource === RUN_TASK_SYNC)) expect(task.environment).toEqual({});
  });

  it("ends successfully when Intake exits 4", async () => {
    const simulation = await run({ intake: [{ exit: 4 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(commands(simulation)).toEqual([["intake", ...issue, "--execution", EXECUTION]]);
  });

  it("Scenario: Escalated proposal ends the execution", async () => {
    const simulation = await run({ proposal: [{ exit: 3 }] });

    expect(simulation.status).toBe("FAILED");
    // No retry, and no Escalate task: the worker has escalated the work item already.
    expect(commands(simulation)).toEqual([
      ["intake", ...issue, "--execution", EXECUTION],
      ["proposal", ...issue],
    ]);
    expect(simulation.waits).toEqual([]);
  });

  it("Scenario: Worker crash escalates the work item", async () => {
    const states: { state: WorkerState; before: string[][] }[] = [
      { state: "intake", before: [] },
      { state: "proposal", before: [["intake", ...issue, "--execution", EXECUTION]] },
      {
        state: "approved",
        before: [
          ["intake", ...issue, "--execution", EXECUTION],
          ["proposal", ...issue],
          ["await-approval", ...issue],
        ],
      },
    ];
    for (const { state, before } of states) {
      const own = state === "intake" ? ["intake", ...issue, "--execution", EXECUTION] : [state, ...issue];

      // Exit 1, or a task that never ran: two retries after 30 s and 90 s, then Escalate, then Fail.
      for (const [label, crash] of crashes) {
        const simulation = await run({ [state]: [crash, crash, crash] });

        expect(simulation.status, `${state} ${label}`).toBe("FAILED");
        expect(commands(simulation), `${state} ${label}`).toEqual([...before, own, own, own, ["escalate", ...issue, "--reason", "worker-failed"]]);
        expect(simulation.waits, `${state} ${label}`).toEqual([30, 90]);
      }

      // Exit 2: the worker refused its input; a retry cannot help, so Escalate at once.
      const refused = await run({ [state]: [{ exit: 2 }] });

      expect(refused.status, `${state} exit 2`).toBe("FAILED");
      expect(commands(refused), `${state} exit 2`).toEqual([...before, own, ["escalate", ...issue, "--reason", "worker-refused"]]);
      expect(refused.waits, `${state} exit 2`).toEqual([]);
    }
  });

  it("goes on after a retry that succeeds, and counts retries per state", async () => {
    const simulation = await run({ intake: [{ exit: 1 }], proposal: [{ notStarted: true }, { exit: 1 }], approved: [{ exit: 1 }, { exit: 1 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(commands(simulation).map((command) => command[0])).toEqual([
      "intake",
      "intake",
      "proposal",
      "proposal",
      "proposal",
      "await-approval",
      "approved",
      "approved",
      "approved",
    ]);
    expect(simulation.waits).toEqual([30, 30, 90, 30, 90]);
  });

  it("fails after Escalate even when the Escalate task fails", async () => {
    for (const [label, crash] of crashes) {
      const simulation = await run({ proposal: [{ exit: 1 }, { exit: 1 }, { exit: 1 }], escalate: [crash] });

      expect(simulation.status, label).toBe("FAILED");
      expect(commands(simulation).filter((command) => command[0] === "escalate"), label).toHaveLength(1);
    }
  });

  it("escalates when AwaitApproval fails, without retrying it", async () => {
    // Step Functions does not watch a waitForTaskToken task: only SendTaskFailure, or RunTask
    // itself failing, ends the state. A worker that dies silently leaves it paused (design, "Risks").
    const outcomes: TaskOutcome[] = [
      { failure: { error: "factory.AwaitApprovalFailed", cause: "await-approval failed" } },
      { ecsError: "Rate exceeded (Service: AmazonECS; Status Code: 400; Error Code: ThrottlingException)" },
    ];
    for (const outcome of outcomes) {
      const simulation = await run({ "await-approval": [outcome] });

      expect(simulation.status).toBe("FAILED");
      expect(commands(simulation).slice(2)).toEqual([
        ["await-approval", ...issue],
        ["escalate", ...issue, "--reason", "worker-failed"],
      ]);
    }
  });

  it("Scenario: Execution history holds no artifacts or secrets", async () => {
    const asl = definition(CONFIG) as { States: Record<string, Record<string, unknown>> };

    // Static half: every expression reads only the issue number, the execution ARN, the task
    // token, exit codes, and the factory's own variables (the issue number, a retry count and
    // an escalation reason).
    const allowedPaths = new Set([
      "$states.input.issueNumber",
      "$states.context.Execution.Id",
      "$states.context.Task.Token",
      "$states.result.Containers[0].ExitCode",
      "$states.errorOutput.Cause",
      "$states.input.exitCode",
    ]);
    const allowedVariables = new Set(["$issueNumber", "$tries", "$reason"]);
    const expressions = templates(asl);
    expect(expressions.length).toBeGreaterThan(0);
    for (const expression of expressions) {
      for (const path of expression.match(/\$states(?:\.[A-Za-z]+|\[\d+\])*/g) ?? []) expect(allowedPaths, expression).toContain(path);
      for (const variable of expression.match(/\$(?!states\b)[A-Za-z]\w*\b(?!\s*\()/g) ?? []) expect(allowedVariables, expression).toContain(variable);
    }

    // Every task passes on a small output of its own, never the ECS task description.
    for (const [name, state] of Object.entries(asl.States)) {
      if (state["Type"] !== "Task") continue;
      expect(state["Output"], name).toBeDefined();
      for (const catcher of (state["Catch"] as Record<string, unknown>[] | undefined) ?? []) expect(catcher["Output"], name).toBeDefined();
    }

    // Overrides carry state names, the issue number, the execution ARN, a fixed reason code and,
    // for AwaitApproval, the task token: nothing else.
    const simulations = [
      await run(),
      await run({ intake: [{ exit: 4 }] }),
      await run({ proposal: [{ exit: 3 }] }),
      await run({ proposal: [{ exit: 1 }, { notStarted: true }, { exit: 1 }] }),
      await run({ approved: [{ exit: 2 }] }),
      await run({ "await-approval": [{ success: { approvedBy: "miklospocsaji", proposal: "## Why …" } }] }),
    ];
    for (const simulation of simulations) {
      for (const task of simulation.tasks) {
        const [override] = (task.arguments["Overrides"] as { ContainerOverrides: Record<string, unknown>[] }).ContainerOverrides;
        expect(Object.keys(override ?? {}).sort()).toEqual(task.taskToken === undefined ? ["Command", "Name"] : ["Command", "Environment", "Name"]);
        for (const word of task.command) {
          expect(
            ["intake", "proposal", "await-approval", "approved", "escalate", "--issue", String(ISSUE), "--execution", EXECUTION, "--reason", "worker-failed", "worker-refused"],
          ).toContain(word);
        }
      }

      // State inputs and outputs, and variables, are pointers and exit codes only.
      for (const record of simulation.records) {
        for (const value of [record.input, record.output]) {
          if (value === undefined) continue;
          expect(typeof value, record.state).toBe("object");
          for (const key of Object.keys(value as object)) expect(["issueNumber", "exitCode"], `${record.state}: ${key}`).toContain(key);
        }
        for (const [key, value] of Object.entries(record.variables)) {
          expect(["issueNumber", "tries", "reason"], key).toContain(key);
          expect(["number", "string"], key).toContain(typeof value);
          expect(JSON.stringify(value)).not.toMatch(/task-token|Containers|approvedBy/);
        }
      }
      // A state's error output (with the task description) never becomes a later state's input.
      for (const record of simulation.records.slice(1)) {
        expect(JSON.stringify(record.input ?? null), record.state).not.toMatch(/Containers|task-token|approvedBy/);
      }
    }
  });
});

/** Every JSONata expression in the definition, without its `{% %}`. */
function templates(value: unknown): string[] {
  if (typeof value === "string") {
    const match = /^\{%([\s\S]*)%\}$/.exec(value);
    return match === null ? [] : [match[1] ?? ""];
  }
  if (Array.isArray(value)) return value.flatMap(templates);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(templates);
  return [];
}
