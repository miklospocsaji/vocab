/**
 * The work item's Step Functions state machine (add-cloud-proposal-run design, "State
 * machine"): a pure function returning JSONata ASL, so it is unit-tested without CDK or AWS.
 *
 *   Start ─▶ Intake ─▶ Proposal ─▶ AwaitApproval ─▶ Approved ─▶ Done
 *              │ 4        │ 3                          (each worker state: 2, or crashes
 *              ▼          ▼                             after 2 retries, ─▶ Escalate ─▶ Escalated)
 *            Ended    Escalated
 *
 * Every state is a `factory-worker` task. States pass only the issue number and an exit code;
 * AwaitApproval passes its task token to the worker in the environment.
 *
 * Where the exit code is read from follows the spike of task 3.1 (design.md): exit 0 completes
 * the state with the ECS task description as its result; any other exit fails it with
 * `States.TaskFailed` and the description, as a JSON string, in `Cause`. A task that never ran
 * has no exit code, and an ECS error has a plain-text cause: both count as a crash.
 */
import { ESCALATION_REASON, WORKER_EXIT } from "./exit-codes.ts";

/** Where and how the state machine runs worker tasks. In CDK, these are tokens. */
export interface WorkerTaskConfig {
  cluster: string;
  taskDefinition: string;
  subnets: string[];
  securityGroup: string;
  /** The worker's container, which the overrides name. */
  container: string;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface StateMachineDefinition {
  Comment: string;
  QueryLanguage: "JSONata";
  StartAt: string;
  States: Record<string, Record<string, Json>>;
}

/** The environment variable that carries AwaitApproval's task token to the worker. */
export const TASK_TOKEN_VAR = "FACTORY_TASK_TOKEN";

/** Retries of a crashed worker task, and the wait before each. */
export const RETRY_WAITS_SECONDS = [30, 90] as const;

const RUN_TASK_SYNC = "arn:aws:states:::ecs:runTask.sync";
const RUN_TASK_WAIT_FOR_TOKEN = "arn:aws:states:::ecs:runTask.waitForTaskToken";

const ISSUE = "$string($issueNumber)";
const EXIT_CODE = "$states.input.exitCode";
const CAUSE = "$states.errorOutput.Cause";
/** The exit code from a failed state's task description; null when the cause is not one, or has none. */
const FAILED_EXIT_CODE = `$type(${CAUSE}) = 'string' and $substring(${CAUSE}, 0, 1) = '{' ? $parse(${CAUSE}).Containers[0].ExitCode : null`;

const expr = (expression: string): string => `{% ${expression} %}`;
const quote = (text: string): string => `'${text}'`;

export function definition(config: WorkerTaskConfig): StateMachineDefinition {
  const runTask = (command: string[], environment?: { Name: string; Value: string }[]): Json => ({
    Cluster: config.cluster,
    TaskDefinition: config.taskDefinition,
    LaunchType: "FARGATE",
    NetworkConfiguration: {
      AwsvpcConfiguration: { Subnets: config.subnets, SecurityGroups: [config.securityGroup], AssignPublicIp: "ENABLED" },
    },
    Overrides: {
      ContainerOverrides: [
        { Name: config.container, Command: expr(`[${command.join(", ")}]`), ...(environment === undefined ? {} : { Environment: environment }) },
      ],
    },
  });

  /**
   * A worker state run to completion, then routed on its exit code by `<name>Exit`: the routes
   * given, then exit 2 to Escalate at once, a crash to a retry while retries are left, and
   * anything else to Escalate.
   */
  const workerState = (name: string, command: string[], routes: { exit: number; next: string }[]) => ({
    [name]: {
      Type: "Task",
      Resource: RUN_TASK_SYNC,
      Arguments: runTask(command),
      Output: expr(`{ 'exitCode': $states.result.Containers[0].ExitCode }`),
      Catch: [{ ErrorEquals: ["States.ALL"], Output: expr(`{ 'exitCode': ${FAILED_EXIT_CODE} }`), Next: `${name}Exit` }],
      Next: `${name}Exit`,
    },
    [`${name}Exit`]: {
      Type: "Choice",
      Choices: [
        ...routes.map((route) => ({
          Condition: expr(`${EXIT_CODE} = ${String(route.exit)}`),
          // A state that goes on starts the next one with its retries unused.
          ...(route.exit === WORKER_EXIT.ok ? { Assign: { tries: 0 } } : {}),
          Next: route.next,
        })),
        { Condition: expr(`${EXIT_CODE} = ${String(WORKER_EXIT.invalid)}`), Assign: { reason: ESCALATION_REASON.refused }, Next: "Escalate" },
        { Condition: expr(`$tries < ${String(RETRY_WAITS_SECONDS.length)}`), Assign: { tries: expr("$tries + 1") }, Next: `${name}Retry` },
      ],
      Assign: { reason: ESCALATION_REASON.failed },
      Default: "Escalate",
    },
    [`${name}Retry`]: {
      Type: "Wait",
      // $tries is already this retry's number.
      Seconds: expr(`$tries = 1 ? ${String(RETRY_WAITS_SECONDS[0])} : ${String(RETRY_WAITS_SECONDS[1])}`),
      Next: name,
    },
  });

  return {
    Comment: "One factory work item: Intake, Proposal and the owner's approval (add-cloud-proposal-run).",
    QueryLanguage: "JSONata",
    StartAt: "Start",
    States: {
      Start: {
        Type: "Pass",
        Assign: { issueNumber: expr("$states.input.issueNumber"), tries: 0 },
        Output: expr("{ 'issueNumber': $states.input.issueNumber }"),
        Next: "Intake",
      },
      ...workerState("Intake", [quote("intake"), quote("--issue"), ISSUE, quote("--execution"), "$states.context.Execution.Id"], [
        { exit: WORKER_EXIT.ok, next: "Proposal" },
        { exit: WORKER_EXIT.ended, next: "Ended" },
      ]),
      ...workerState("Proposal", [quote("proposal"), quote("--issue"), ISSUE], [
        { exit: WORKER_EXIT.ok, next: "AwaitApproval" },
        { exit: WORKER_EXIT.escalated, next: "Escalated" },
      ]),
      AwaitApproval: {
        Type: "Task",
        Resource: RUN_TASK_WAIT_FOR_TOKEN,
        Arguments: runTask([quote("await-approval"), quote("--issue"), ISSUE], [{ Name: TASK_TOKEN_VAR, Value: expr("$states.context.Task.Token") }]),
        // No timeout in M2 (design, "Risks"). The approve worker's output is dropped.
        Output: {},
        Catch: [{ ErrorEquals: ["States.ALL"], Assign: { reason: ESCALATION_REASON.failed }, Output: {}, Next: "Escalate" }],
        Next: "Approved",
      },
      ...workerState("Approved", [quote("approved"), quote("--issue"), ISSUE], [{ exit: WORKER_EXIT.ok, next: "Done" }]),
      Escalate: {
        Type: "Task",
        Resource: RUN_TASK_SYNC,
        Arguments: runTask([quote("escalate"), quote("--issue"), ISSUE, quote("--reason"), "$reason"]),
        Output: {},
        // The execution fails either way; if this task cannot run, no comment is posted (design, "Risks").
        Catch: [{ ErrorEquals: ["States.ALL"], Output: {}, Next: "Escalated" }],
        Next: "Escalated",
      },
      Escalated: { Type: "Fail", Error: "WorkItemEscalated", Cause: "The work item is escalated and waits for the owner." },
      Ended: { Type: "Succeed", Comment: "Intake ended the run: the issue was rejected, or has a work item from another execution." },
      Done: { Type: "Succeed", Comment: "The proposal is approved; the work item is proposal-approved." },
    },
  };
}
