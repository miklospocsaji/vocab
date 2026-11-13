/**
 * The work item's state machine (add-cloud-proposal-run task 3.2, add-build-loop task 4.3):
 * `definition()` is pure ASL, run here by the simulator in asl-simulator.ts with the real JSONata
 * library and scripted worker and build outcomes, shaped as the spike of task 3.1 measured them.
 * No AWS.
 */
import { describe, expect, it } from "vitest";
import { definition, type WorkerTaskConfig } from "../src/state-machine.ts";
import { RUN_TASK_SYNC, RUN_TASK_WAIT_FOR_TOKEN, simulate, type Simulation, type TaskCall, type TaskOutcome } from "./asl-simulator.ts";

const CONFIG: WorkerTaskConfig = {
  cluster: "arn:aws:ecs:eu-central-1:123456789012:cluster/factory",
  taskDefinition: "FactoryWorker",
  subnets: ["subnet-0aaa", "subnet-0bbb"],
  securityGroup: "sg-0worker",
  container: "worker",
  build: { taskDefinition: "FactoryBuild", securityGroup: "sg-0build", container: "build" },
};
const EXECUTION = "arn:aws:states:eu-central-1:123456789012:execution:factory-work-item:issue-12-5f0c";
const ISSUE = 12;
const INPUT = { issueNumber: ISSUE };
const CHANGE_ID = "add-import-kindle-vocab-db";
const PLANNED = { exitCode: 0, changeId: CHANGE_ID, tasks: ["1.1", "1.2"] };

/**
 * The tasks the definition runs, as their command's first word; the design approval's
 * `await-approval --kind design` is `await-design-approval`.
 */
type TaskKind = "intake" | "proposal" | "await-approval" | "approved" | "design" | "await-design-approval" | "plan" | "step" | "build" | "open-pr" | "escalate";

function kindOf(call: TaskCall): string {
  const [first] = call.command;
  if (first === "await-approval" && call.command.includes("design")) return "await-design-approval";
  return first ?? "";
}

/**
 * Runs the definition with each task's outcomes, in order. A task with no outcome left exits 0
 * (`.sync`), is approved (`.waitForTaskToken`), or for Plan returns PLANNED.
 */
async function run(script: Partial<Record<TaskKind, TaskOutcome[]>> = {}): Promise<Simulation> {
  const queues = Object.fromEntries(Object.entries(script).map(([kind, outcomes]) => [kind, [...outcomes]])) as Partial<Record<string, TaskOutcome[]>>;
  return simulate(definition(CONFIG), INPUT, {
    executionArn: EXECUTION,
    onTask: (call: TaskCall) => {
      const kind = kindOf(call);
      const next = queues[kind]?.shift();
      if (next !== undefined) return next;
      if (kind === "plan") return { success: PLANNED };
      return call.resource === RUN_TASK_WAIT_FOR_TOKEN ? { success: {} } : { exit: 0 };
    },
  });
}

const issue = ["--issue", String(ISSUE)];
const commands = (simulation: Simulation) => simulation.tasks.map((task) => task.command);
const kinds = (simulation: Simulation) => simulation.tasks.map(kindOf);
const crashes: [string, TaskOutcome][] = [
  ["exits 1", { exit: 1 }],
  ["never starts", { notStarted: true }],
  ["cannot be run", { ecsError: "Rate exceeded (Service: AmazonECS; Status Code: 400; Error Code: ThrottlingException)" }],
];

const INTAKE = ["intake", ...issue, "--execution", EXECUTION];
const step = (task: string) => ["step", ...issue, "--task", task];
const build = (task: string) => ["build", "--change", CHANGE_ID, "--task", task];
/** Up to Approved, as every route after Proposal starts. */
const UP_TO_APPROVED = [INTAKE, ["proposal", ...issue], ["await-approval", ...issue], ["approved", ...issue]];

type States = Record<string, Record<string, unknown>>;

/** Every state of the definition, the Map's item processor's included, by name. */
function allStates(): States {
  const asl = definition(CONFIG) as unknown as { States: States };
  const states: States = { ...asl.States };
  for (const state of Object.values(asl.States)) {
    const processor = state["ItemProcessor"] as { States?: States } | undefined;
    Object.assign(states, processor?.States ?? {});
  }
  return states;
}

describe("state machine definition", () => {
  it("uses JSONata for the whole definition", () => {
    const asl = definition(CONFIG) as { QueryLanguage?: unknown; States: Record<string, Record<string, unknown>> };

    expect(asl.QueryLanguage).toBe("JSONata");
    for (const [name, state] of Object.entries(allStates())) {
      expect(state["QueryLanguage"] ?? "JSONata", name).toBe("JSONata");
      for (const field of ["Parameters", "InputPath", "OutputPath", "ResultPath", "ResultSelector", "ItemsPath"]) expect(state, name).not.toHaveProperty(field);
    }
    // The definition is plain JSON: CDK serialises it with its tokens.
    expect(JSON.parse(JSON.stringify(asl))).toEqual(asl);
  });

  it("runs a medium change from Intake through Design, Plan and the build loop to the pull request", async () => {
    const simulation = await run();

    expect(simulation.status).toBe("SUCCEEDED");
    expect(commands(simulation)).toEqual([...UP_TO_APPROVED, ["design", ...issue], ["plan", ...issue], step("1.1"), step("1.2"), ["open-pr", ...issue]]);
    expect(kinds(simulation).filter((_, i) => simulation.tasks[i]?.resource === RUN_TASK_WAIT_FOR_TOKEN)).toEqual(["await-approval", "plan"]);
    expect(simulation.waits).toEqual([]);
  });

  it("routes a small change from Approved straight to Plan", async () => {
    const simulation = await run({ approved: [{ exit: 10 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(kinds(simulation)).toEqual(["intake", "proposal", "await-approval", "approved", "plan", "step", "step", "open-pr"]);
  });

  it("routes a large change's design to the owner's approval, then to Plan", async () => {
    const simulation = await run({ design: [{ exit: 11 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(kinds(simulation).slice(4, 7)).toEqual(["design", "await-design-approval", "plan"]);
    const approval = simulation.tasks[5];
    expect(approval?.resource).toBe(RUN_TASK_WAIT_FOR_TOKEN);
    expect(approval?.command).toEqual(["await-approval", ...issue, "--kind", "design"]);
    expect(approval?.environment).toEqual({ FACTORY_TASK_TOKEN: approval?.taskToken });
  });

  it("escalates when the design approval fails, without retrying it", async () => {
    const simulation = await run({ design: [{ exit: 11 }], "await-design-approval": [{ failure: { error: "factory.AwaitApprovalFailed", cause: "failed" } }] });

    expect(simulation.status).toBe("FAILED");
    expect(commands(simulation).slice(-2)).toEqual([
      ["await-approval", ...issue, "--kind", "design"],
      ["escalate", ...issue, "--reason", "worker-failed"],
    ]);
  });

  it("ends failed with no Escalate task when Design escalates", async () => {
    const simulation = await run({ design: [{ exit: 3 }] });

    expect(simulation.status).toBe("FAILED");
    expect(simulation.error).toBe("WorkItemEscalated");
    expect(kinds(simulation).at(-1)).toBe("design");
    expect(kinds(simulation)).not.toContain("escalate");
  });

  it("waits for Plan's task token, with a two-hour timeout, and takes the change id and task ids from its output", async () => {
    const states = allStates();
    expect(states["Plan"]).toMatchObject({ Resource: RUN_TASK_WAIT_FOR_TOKEN, TimeoutSeconds: 7200 });
    expect(states["Plan"]).not.toHaveProperty("HeartbeatSeconds");

    const simulation = await run({ plan: [{ success: { exitCode: 0, changeId: CHANGE_ID, tasks: ["2.1", "2.3", "2.2"] } }] });

    expect(simulation.status).toBe("SUCCEEDED");
    const plan = simulation.tasks.find((task) => kindOf(task) === "plan");
    expect(plan?.environment).toEqual({ FACTORY_TASK_TOKEN: plan?.taskToken });
    // The build loop steps the tasks in the order Plan gave them.
    expect(commands(simulation).filter((command) => command[0] === "step")).toEqual([step("2.1"), step("2.3"), step("2.2")]);
  });

  it("goes straight to the pull request when Plan leaves no task unfinished", async () => {
    const simulation = await run({ plan: [{ success: { exitCode: 0, changeId: CHANGE_ID, tasks: [] } }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(kinds(simulation).slice(-2)).toEqual(["plan", "open-pr"]);
  });

  it("ends failed with no Escalate task when Plan reports an escalation, and escalates when Plan fails", async () => {
    const escalated = await run({ plan: [{ success: { exitCode: 3, changeId: CHANGE_ID, tasks: [] } }] });

    expect(escalated.status).toBe("FAILED");
    expect(escalated.error).toBe("WorkItemEscalated");
    expect(kinds(escalated).at(-1)).toBe("plan");

    for (const outcome of [{ failure: { error: "factory.PlanFailed", cause: "failed" } }, { ecsError: "Rate exceeded" }, { success: { exitCode: 1 } }] as TaskOutcome[]) {
      const failed = await run({ plan: [outcome] });

      expect(failed.status, JSON.stringify(outcome)).toBe("FAILED");
      expect(commands(failed).slice(-2), JSON.stringify(outcome)).toEqual([
        ["plan", ...issue],
        ["escalate", ...issue, "--reason", "worker-failed"],
      ]);
    }
  });

  it("runs the build loop as an inline Map over $tasks, one task at a time, catching DesignFlaw into Design and WorkItemEscalated into Escalated", () => {
    const asl = definition(CONFIG) as unknown as { States: States };
    const maps = Object.entries(asl.States).filter(([, state]) => state["Type"] === "Map");
    expect(maps).toHaveLength(1);
    const [name, map] = maps[0] ?? ["", {}];
    expect(name).toBe("BuildTasks");
    expect(map["MaxConcurrency"]).toBe(1);
    expect(map["Items"]).toBe("{% $tasks %}");
    expect(map["ItemProcessor"]).toMatchObject({ ProcessorConfig: { Mode: "INLINE" } });
    expect(map["Next"]).toBe("OpenPullRequest");

    const catches = (map["Catch"] as { ErrorEquals: string[]; Next: string }[] | undefined) ?? [];
    const route = (error: string) => catches.find((c) => c.ErrorEquals.includes(error))?.Next;
    expect(route("DesignFlaw")).toBe("Design");
    expect(route("WorkItemEscalated")).toBe("Escalated");
    // Anything else (a crashed step out of retries) still goes to Escalate.
    expect(catches.at(-1)).toMatchObject({ ErrorEquals: ["States.ALL"], Next: "Escalate" });

    const processor = (map["ItemProcessor"] as { States: States }).States;
    const fails = Object.values(processor).filter((state) => state["Type"] === "Fail").map((state) => state["Error"]);
    expect(fails).toEqual(expect.arrayContaining(["DesignFlaw", "WorkItemEscalated"]));
  });

  it("runs Build between steps until a step reports the task done", async () => {
    const simulation = await run({ step: [{ exit: 20 }, { exit: 20 }, { exit: 0 }, { exit: 0 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(commands(simulation).slice(6, -1)).toEqual([step("1.1"), build("1.1"), step("1.1"), build("1.1"), step("1.1"), step("1.2")]);
  });

  it("runs Build as the build task definition, in the build security group, with no environment override", async () => {
    const simulation = await run({ step: [{ exit: 20 }] });

    const builds = simulation.tasks.filter((task) => kindOf(task) === "build");
    expect(builds).toHaveLength(1);
    const [buildTask] = builds;
    expect(buildTask?.resource).toBe(RUN_TASK_SYNC);
    expect(buildTask?.arguments).toMatchObject({
      Cluster: CONFIG.cluster,
      TaskDefinition: "FactoryBuild",
      LaunchType: "FARGATE",
      NetworkConfiguration: { AwsvpcConfiguration: { Subnets: CONFIG.subnets, SecurityGroups: ["sg-0build"], AssignPublicIp: "ENABLED" } },
    });
    const overrides = (buildTask?.arguments["Overrides"] as { ContainerOverrides: Record<string, unknown>[] }).ContainerOverrides;
    expect(overrides).toEqual([{ Name: "build", Command: build("1.1") }]);
  });

  it("waits 60 seconds before a build that follows an infrastructure failure", async () => {
    const simulation = await run({ step: [{ exit: 21 }, { exit: 0 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(commands(simulation).slice(6, 9)).toEqual([step("1.1"), build("1.1"), step("1.1")]);
    expect(simulation.waits).toEqual([60]);
  });

  it("retries a crashed build twice, then steps again, which records the missing outcome", async () => {
    for (const [label, crash] of crashes) {
      const simulation = await run({ step: [{ exit: 20 }, { exit: 0 }], build: [crash, crash, crash] });

      expect(simulation.status, label).toBe("SUCCEEDED");
      expect(commands(simulation).slice(6, 11), label).toEqual([step("1.1"), build("1.1"), build("1.1"), build("1.1"), step("1.1")]);
      expect(simulation.waits, label).toEqual([30, 90]);
    }

    // A build that refused its input is not retried.
    const refused = await run({ step: [{ exit: 20 }, { exit: 0 }], build: [{ exit: 2 }] });
    expect(commands(refused).slice(6, 9)).toEqual([step("1.1"), build("1.1"), step("1.1")]);
    expect(refused.waits).toEqual([]);
  });

  it("counts build retries per build, and step retries per step", async () => {
    const simulation = await run({ step: [{ exit: 20 }, { exit: 1 }, { exit: 20 }, { exit: 0 }], build: [{ exit: 1 }, { exit: 0 }, { exit: 1 }, { exit: 1 }, { exit: 0 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(kinds(simulation).slice(6, -2)).toEqual(["step", "build", "build", "step", "step", "build", "build", "build", "step"]);
    expect(simulation.waits).toEqual([30, 30, 30, 90]);
  });

  it("goes back to Design on a design flaw, then re-plans and builds the new plan's tasks", async () => {
    const simulation = await run({
      step: [{ exit: 0 }, { exit: 13 }],
      plan: [{ success: PLANNED }, { success: { exitCode: 0, changeId: CHANGE_ID, tasks: ["1.2", "1.3"] } }],
    });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(commands(simulation).slice(4)).toEqual([
      ["design", ...issue],
      ["plan", ...issue],
      step("1.1"),
      step("1.2"),
      ["design", ...issue],
      ["plan", ...issue],
      step("1.2"),
      step("1.3"),
      ["open-pr", ...issue],
    ]);
  });

  it("ends failed with no Escalate task when a step reports an escalation", async () => {
    const simulation = await run({ step: [{ exit: 20 }, { exit: 3 }] });

    expect(simulation.status).toBe("FAILED");
    expect(simulation.error).toBe("WorkItemEscalated");
    expect(kinds(simulation).slice(-3)).toEqual(["step", "build", "step"]);
  });

  it("Scenario: Escalated proposal ends the execution", async () => {
    const simulation = await run({ proposal: [{ exit: 3 }] });

    expect(simulation.status).toBe("FAILED");
    // No retry, and no Escalate task: the worker has escalated the work item already.
    expect(commands(simulation)).toEqual([INTAKE, ["proposal", ...issue]]);
    expect(simulation.waits).toEqual([]);
  });

  it("Scenario: Worker crash escalates the work item", async () => {
    const states: { kind: TaskKind; before: string[][]; own: string[] }[] = [
      { kind: "intake", before: [], own: INTAKE },
      { kind: "proposal", before: [INTAKE], own: ["proposal", ...issue] },
      { kind: "approved", before: UP_TO_APPROVED.slice(0, 3), own: ["approved", ...issue] },
      { kind: "design", before: UP_TO_APPROVED, own: ["design", ...issue] },
      { kind: "step", before: [...UP_TO_APPROVED, ["design", ...issue], ["plan", ...issue]], own: step("1.1") },
      { kind: "open-pr", before: [...UP_TO_APPROVED, ["design", ...issue], ["plan", ...issue], step("1.1"), step("1.2")], own: ["open-pr", ...issue] },
    ];
    for (const { kind, before, own } of states) {
      // Exit 1, or a task that never ran: two retries after 30 s and 90 s, then Escalate, then Fail.
      for (const [label, crash] of crashes) {
        const simulation = await run({ [kind]: [crash, crash, crash] });

        expect(simulation.status, `${kind} ${label}`).toBe("FAILED");
        expect(commands(simulation), `${kind} ${label}`).toEqual([...before, own, own, own, ["escalate", ...issue, "--reason", "worker-failed"]]);
        expect(simulation.waits, `${kind} ${label}`).toEqual([30, 90]);
      }

      // Exit 2: the worker refused its input; a retry cannot help, so Escalate at once.
      const refused = await run({ [kind]: [{ exit: 2 }] });

      expect(refused.status, `${kind} exit 2`).toBe("FAILED");
      expect(commands(refused), `${kind} exit 2`).toEqual([...before, own, ["escalate", ...issue, "--reason", "worker-refused"]]);
      expect(refused.waits, `${kind} exit 2`).toEqual([]);
    }
  });

  it("runs every worker task as the worker on Fargate, in the public subnets with a public IP", async () => {
    const simulation = await run({ proposal: [{ exit: 1 }, { exit: 1 }, { exit: 1 }] });
    const all = [...simulation.tasks, ...(await run({ step: [{ exit: 20 }] })).tasks].filter((task) => kindOf(task) !== "build");

    expect(all.length).toBeGreaterThan(4);
    for (const task of all) {
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

  it("passes each waitForTaskToken task its own token as FACTORY_TASK_TOKEN, and only there", async () => {
    const simulation = await run({ design: [{ exit: 11 }], step: [{ exit: 20 }] });

    const waiting = simulation.tasks.filter((task) => task.resource === RUN_TASK_WAIT_FOR_TOKEN);
    expect(waiting.map(kindOf)).toEqual(["await-approval", "await-design-approval", "plan"]);
    for (const task of waiting) {
      expect(task.taskToken).toBeTruthy();
      expect(task.environment).toEqual({ FACTORY_TASK_TOKEN: task.taskToken });
    }
    expect(new Set(waiting.map((task) => task.taskToken)).size).toBe(3);
    for (const task of simulation.tasks.filter((t) => t.resource === RUN_TASK_SYNC)) expect(task.environment).toEqual({});
  });

  it("ends successfully when Intake exits 4", async () => {
    const simulation = await run({ intake: [{ exit: 4 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(commands(simulation)).toEqual([INTAKE]);
  });

  it("goes on after a retry that succeeds, and counts retries per state", async () => {
    const simulation = await run({ intake: [{ exit: 1 }], proposal: [{ notStarted: true }, { exit: 1 }], approved: [{ exit: 1 }, { exit: 1 }] });

    expect(simulation.status).toBe("SUCCEEDED");
    expect(kinds(simulation)).toEqual(["intake", "intake", "proposal", "proposal", "proposal", "await-approval", "approved", "approved", "approved", "design", "plan", "step", "step", "open-pr"]);
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
    const states = allStates();

    // Static half: every expression reads only the issue number, the change id, task ids, the
    // execution ARN, task tokens, exit codes, and the factory's own variables (the issue number,
    // the change id, the task ids, retry counts and an escalation reason).
    const allowedPaths = new Set([
      "$states.input.issueNumber",
      "$states.input",
      "$states.context.Execution.Id",
      "$states.context.Task.Token",
      "$states.result.Containers[0].ExitCode",
      "$states.result.exitCode",
      "$states.result.changeId",
      "$states.result.tasks",
      "$states.errorOutput.Cause",
      "$states.input.exitCode",
    ]);
    const allowedVariables = new Set(["$issueNumber", "$changeId", "$tasks", "$taskId", "$tries", "$itemTries", "$reason"]);
    const expressions = templates(asl);
    expect(expressions.length).toBeGreaterThan(0);
    for (const expression of expressions) {
      for (const path of expression.match(/\$states(?:\.[A-Za-z]+|\[\d+\])*/g) ?? []) expect(allowedPaths, expression).toContain(path);
      for (const variable of expression.match(/\$(?!states\b)[A-Za-z]\w*\b(?!\s*\()/g) ?? []) expect(allowedVariables, expression).toContain(variable);
    }

    // Every task and the Map pass on a small output of their own, never a task description or result list.
    for (const [name, state] of Object.entries(states)) {
      if (state["Type"] !== "Task" && state["Type"] !== "Map") continue;
      expect(state["Output"], name).toBeDefined();
      for (const catcher of (state["Catch"] as Record<string, unknown>[] | undefined) ?? []) expect(catcher["Output"], name).toBeDefined();
    }

    // Overrides carry state names, the issue number, the change id, task ids, the execution ARN, a
    // fixed reason code and, for waitForTaskToken tasks, the task token: nothing else.
    const leaky = { approvedBy: "miklospocsaji", proposal: "## Why …", patch: "diff --git a/x b/x" };
    const simulations = [
      await run(),
      await run({ intake: [{ exit: 4 }] }),
      await run({ proposal: [{ exit: 3 }] }),
      await run({ proposal: [{ exit: 1 }, { notStarted: true }, { exit: 1 }] }),
      await run({ approved: [{ exit: 2 }] }),
      await run({ "await-approval": [{ success: leaky }] }),
      await run({ design: [{ exit: 11 }], "await-design-approval": [{ success: leaky }] }),
      await run({ plan: [{ success: { ...PLANNED, ...leaky } }] }),
      await run({ step: [{ exit: 20 }, { exit: 21 }, { exit: 13 }], build: [{ exit: 1 }, { exit: 0 }] }),
      await run({ step: [{ exit: 20 }, { exit: 3 }] }),
      await run({ step: [{ exit: 1 }, { exit: 1 }, { exit: 1 }] }),
    ];
    const words = new Set([
      ...["intake", "proposal", "await-approval", "approved", "design", "plan", "step", "build", "open-pr", "escalate"],
      ...["--issue", "--execution", "--reason", "--kind", "--change", "--task"],
      ...[String(ISSUE), EXECUTION, CHANGE_ID, "1.1", "1.2", "worker-failed", "worker-refused"],
    ]);
    for (const simulation of simulations) {
      for (const task of simulation.tasks) {
        const [override] = (task.arguments["Overrides"] as { ContainerOverrides: Record<string, unknown>[] }).ContainerOverrides;
        expect(Object.keys(override ?? {}).sort()).toEqual(task.taskToken === undefined ? ["Command", "Name"] : ["Command", "Environment", "Name"]);
        for (const word of task.command) expect(words).toContain(word);
      }

      // State inputs and outputs, and variables, are pointers and exit codes only.
      for (const record of simulation.records) {
        for (const value of [record.input, record.output]) {
          if (value === undefined) continue;
          // A Map item's input is its task id.
          if (typeof value === "string") {
            expect(value, record.state).toMatch(/^\d+(\.\d+)*$/);
            continue;
          }
          expect(typeof value, record.state).toBe("object");
          for (const key of Object.keys(value as object)) expect(["issueNumber", "exitCode"], `${record.state}: ${key}`).toContain(key);
        }
        for (const [key, value] of Object.entries(record.variables)) {
          expect(["issueNumber", "changeId", "tasks", "taskId", "tries", "itemTries", "reason"], key).toContain(key);
          if (key === "tasks") {
            expect(Array.isArray(value), key).toBe(true);
            for (const id of value as unknown[]) expect(id).toMatch(/^\d+(\.\d+)*$/);
          } else expect(["number", "string"], key).toContain(typeof value);
          expect(JSON.stringify(value)).not.toMatch(/task-token|Containers|approvedBy|## Why|diff --git/);
        }
      }
      // A state's error output (with the task description) never becomes a later state's input.
      for (const record of simulation.records.slice(1)) {
        expect(JSON.stringify(record.input ?? null), record.state).not.toMatch(/Containers|task-token|approvedBy|## Why|diff --git/);
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
