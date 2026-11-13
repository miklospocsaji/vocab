/**
 * Test helper: runs a JSONata state machine definition the way Step Functions does, for the
 * subset the factory uses (Pass, Task, Choice, Wait, Succeed, Fail, and an inline Map run one
 * item at a time, add-build-loop task 4.3), with the real JSONata
 * library and scripted ECS task outcomes. No AWS.
 *
 * How a worker task's outcome surfaces follows the spike of task 3.1 (design.md, "Exit-code
 * spike"): exit 0 completes `ecs:runTask.sync` with the ECS task description as the result; any
 * other exit fails the state with `States.TaskFailed` and the description, as a JSON string, in
 * `Cause`. A task that never started fails the same way, with no exit code in the description.
 *
 * Step Functions' `$parse` is added to the library's functions, as AWS adds it.
 *
 * Anything outside the subset (JSONPath fields, `Retry`, other resources) throws, so the
 * definition under test stays inside what this simulator models.
 */
import jsonata from "jsonata";

export const RUN_TASK_SYNC = "arn:aws:states:::ecs:runTask.sync";
export const RUN_TASK_WAIT_FOR_TOKEN = "arn:aws:states:::ecs:runTask.waitForTaskToken";

/** How one worker task ends. */
export type TaskOutcome =
  /** `.sync`: the container exited with this code. */
  | { exit: number }
  /** The task stopped before its container ran (an image pull failure, say): no exit code. */
  | { notStarted: true }
  /** The RunTask call itself failed, with a plain-text cause. */
  | { ecsError: string }
  /** `.waitForTaskToken`: a worker called SendTaskSuccess with this output. */
  | { success: unknown }
  /** `.waitForTaskToken`: a worker called SendTaskFailure. */
  | { failure: { error: string; cause: string } };

export interface TaskCall {
  state: string;
  resource: string;
  /** The evaluated `Arguments`. */
  arguments: Record<string, unknown>;
  /** The worker container's command override. */
  command: string[];
  /** The worker container's environment overrides. */
  environment: Record<string, string>;
  /** The task token, for a `.waitForTaskToken` state. */
  taskToken?: string;
}

/** What a state received and passed on, and the variables after it: what the execution history shows. */
export interface StateRecord {
  state: string;
  input: unknown;
  output: unknown;
  variables: Record<string, unknown>;
}

export interface Simulation {
  status: "SUCCEEDED" | "FAILED";
  /** The Fail state's error, or the uncaught error. */
  error?: string;
  /** Every state entered, in order. */
  path: string[];
  tasks: TaskCall[];
  /** The seconds of every Wait state, in order. */
  waits: number[];
  records: StateRecord[];
}

export interface SimulateOptions {
  executionArn: string;
  /** Answers every task the definition runs. */
  onTask: (call: TaskCall) => TaskOutcome;
  maxSteps?: number;
}

type State = Record<string, unknown>;
type Definition = { QueryLanguage?: unknown; StartAt: string; States: Record<string, State> };

class StateError extends Error {
  readonly error: string;
  override readonly cause: string;

  constructor(error: string, cause: string) {
    super(`${error}: ${cause}`);
    this.error = error;
    this.cause = cause;
  }
}

const JSONPATH_FIELDS = ["Parameters", "InputPath", "OutputPath", "ResultPath", "ResultSelector", "ItemsPath", "ItemSelector"];
const COMMON_FIELDS = ["Type", "Comment", "Next", "End", "Output", "Assign"];
const ALLOWED_FIELDS: Record<string, string[]> = {
  Pass: COMMON_FIELDS,
  Task: [...COMMON_FIELDS, "Resource", "Arguments", "Catch", "TimeoutSeconds", "HeartbeatSeconds"],
  Choice: ["Type", "Comment", "Choices", "Default", "Output", "Assign"],
  Wait: [...COMMON_FIELDS, "Seconds"],
  Succeed: ["Type", "Comment", "Output"],
  Fail: ["Type", "Comment", "Error", "Cause"],
  Map: [...COMMON_FIELDS, "Items", "ItemProcessor", "MaxConcurrency", "Catch"],
};

export async function simulate(definition: unknown, input: unknown, options: SimulateOptions): Promise<Simulation> {
  const def = definition as Definition;
  if (def.QueryLanguage !== "JSONata") throw new Error("the simulator runs JSONata definitions only");
  const result: Simulation = { status: "FAILED", path: [], tasks: [], waits: [], records: [] };
  const run: Run = { result, options, input, maxSteps: options.maxSteps ?? 200, steps: 0, tokens: 0 };

  const ending = await execute(run, def, input, {}, new Set());
  if (ending.kind === "succeeded") result.status = "SUCCEEDED";
  else result.error = ending.error;
  return result;
}

/** One simulation's shared state: what it records, and its step and token counters. */
interface Run {
  result: Simulation;
  options: SimulateOptions;
  input: unknown;
  maxSteps: number;
  steps: number;
  tokens: number;
}

type Ending = { kind: "succeeded"; output: unknown } | { kind: "failed"; error: string; cause: string };

/**
 * Runs states from `StartAt` until one ends: the top-level definition, or a Map's item processor.
 * `outer` names the variables of enclosing scopes, which an inner state may read but, as in Step
 * Functions, never assign.
 */
async function execute(
  run: Run,
  def: { StartAt: string; States: Record<string, State> },
  input: unknown,
  initial: Record<string, unknown>,
  outer: Set<string>,
): Promise<Ending> {
  const { result, options } = run;
  let variables: Record<string, unknown> = { ...initial };
  let current: string | undefined = def.StartAt;
  let value: unknown = input;

  while (current !== undefined) {
    run.steps += 1;
    if (run.steps > run.maxSteps) throw new Error(`no end after ${String(run.maxSteps)} states: ${result.path.join(" → ")}`);
    const name: string = current;
    const state = def.States[name];
    if (state === undefined) throw new Error(`no state ${name}`);
    checkFields(name, state);
    result.path.push(name);

    const context = { Execution: { Id: options.executionArn, Input: run.input }, State: { Name: name } };
    const base = { input: value, context };
    let next: string | undefined;
    let output: unknown;
    let assigned: Record<string, unknown> = {};

    /** A failed Task or Map: its Catch sets output, assigned and next, or the scope ends failed. */
    const caught = async (error: StateError, scopeContext: unknown): Promise<Ending | undefined> => {
      const errorOutput = { Error: error.error, Cause: error.cause };
      const catcher = ((state["Catch"] as State[] | undefined) ?? []).find((c) => {
        const equals = (c["ErrorEquals"] as string[] | undefined) ?? [];
        return equals.includes(error.error) || equals.includes("States.ALL");
      });
      if (catcher === undefined) {
        result.records.push({ state: name, input: value, output: errorOutput, variables });
        return { kind: "failed", error: error.error, cause: error.cause };
      }
      const scope = { input: value, context: scopeContext, errorOutput };
      output = catcher["Output"] === undefined ? errorOutput : await evaluate(catcher["Output"], scope, variables);
      assigned = await evaluateAssign(catcher["Assign"], scope, variables);
      next = catcher["Next"] as string;
      return undefined;
    };

    switch (state["Type"]) {
      case "Pass":
      case "Wait": {
        if (state["Type"] === "Wait") {
          const seconds = await evaluate(state["Seconds"], base, variables);
          if (typeof seconds !== "number") throw new Error(`${name}: Seconds must be a number`);
          result.waits.push(seconds);
        }
        output = state["Output"] === undefined ? value : await evaluate(state["Output"], base, variables);
        assigned = await evaluateAssign(state["Assign"], base, variables);
        next = nextOf(name, state);
        break;
      }
      case "Choice": {
        const choices = (state["Choices"] as State[] | undefined) ?? [];
        let chosen: State | undefined;
        for (const choice of choices) {
          if ((await evaluate(choice["Condition"], base, variables)) === true) {
            chosen = choice;
            break;
          }
        }
        const branch = chosen ?? state;
        output = branch["Output"] === undefined ? value : await evaluate(branch["Output"], base, variables);
        assigned = await evaluateAssign(branch["Assign"], base, variables);
        next = (chosen === undefined ? state["Default"] : chosen["Next"]) as string | undefined;
        if (next === undefined) return { kind: "failed", error: "States.NoChoiceMatched", cause: name };
        break;
      }
      case "Task": {
        const resource = state["Resource"];
        if (resource !== RUN_TASK_SYNC && resource !== RUN_TASK_WAIT_FOR_TOKEN) throw new Error(`${name}: unsupported resource ${String(resource)}`);
        let taskToken: string | undefined;
        if (resource === RUN_TASK_WAIT_FOR_TOKEN) {
          run.tokens += 1;
          taskToken = `task-token-${String(run.tokens)}`;
        }
        const taskContext = { ...context, ...(taskToken === undefined ? {} : { Task: { Token: taskToken } }) };
        const args = (await evaluate(state["Arguments"], { input: value, context: taskContext }, variables)) as Record<string, unknown>;
        const call = taskCall(name, resource, args, taskToken);
        result.tasks.push(call);

        try {
          const taskResult = finish(call, options.onTask(call));
          const after = { input: value, context: taskContext, result: taskResult };
          output = state["Output"] === undefined ? taskResult : await evaluate(state["Output"], after, variables);
          assigned = await evaluateAssign(state["Assign"], after, variables);
          next = nextOf(name, state);
        } catch (error) {
          if (!(error instanceof StateError)) throw error;
          const ending = await caught(error, taskContext);
          if (ending !== undefined) return ending;
        }
        break;
      }
      case "Map": {
        if (state["MaxConcurrency"] !== 1) throw new Error(`${name}: the simulator runs Map items one at a time only (MaxConcurrency 1)`);
        const processor = state["ItemProcessor"] as { ProcessorConfig?: { Mode?: unknown }; StartAt: string; States: Record<string, State> } | undefined;
        if (processor?.ProcessorConfig?.Mode !== "INLINE") throw new Error(`${name}: only inline Map processors are modelled`);
        const items = await evaluate(state["Items"], base, variables);
        if (!Array.isArray(items)) throw new Error(`${name}: Items must be an array`);

        const inner = new Set([...outer, ...Object.keys(variables)]);
        const outputs: unknown[] = [];
        let failure: StateError | undefined;
        for (const item of items) {
          const ending = await execute(run, processor, item, variables, inner);
          if (ending.kind === "failed") {
            failure = new StateError(ending.error, ending.cause);
            break;
          }
          outputs.push(ending.output);
        }
        if (failure !== undefined) {
          const ending = await caught(failure, context);
          if (ending !== undefined) return ending;
          break;
        }
        const after = { input: value, context, result: outputs };
        output = state["Output"] === undefined ? outputs : await evaluate(state["Output"], after, variables);
        assigned = await evaluateAssign(state["Assign"], after, variables);
        next = nextOf(name, state);
        break;
      }
      case "Succeed":
        output = state["Output"] === undefined ? value : await evaluate(state["Output"], base, variables);
        result.records.push({ state: name, input: value, output, variables });
        return { kind: "succeeded", output };
      case "Fail":
        result.records.push({ state: name, input: value, output: undefined, variables });
        return { kind: "failed", error: String(state["Error"]), cause: typeof state["Cause"] === "string" ? state["Cause"] : "" };
      default:
        throw new Error(`${name}: unsupported state type ${String(state["Type"])}`);
    }

    for (const key of Object.keys(assigned)) {
      if (outer.has(key)) throw new Error(`${name}: assigns $${key}, a variable of an outer scope`);
    }
    variables = { ...variables, ...assigned };
    result.records.push({ state: name, input: value, output, variables });
    value = output;
    current = next;
  }
  // The last state had End: true.
  return { kind: "succeeded", output: value };
}

function checkFields(name: string, state: State): void {
  const type = String(state["Type"]);
  const allowed = ALLOWED_FIELDS[type];
  if (allowed === undefined) throw new Error(`${name}: unsupported state type ${type}`);
  for (const field of Object.keys(state)) {
    if (JSONPATH_FIELDS.includes(field)) throw new Error(`${name}: ${field} is a JSONPath field`);
    if (!allowed.includes(field)) throw new Error(`${name}: field ${field} is not modelled for ${type} states`);
  }
}

function nextOf(name: string, state: State): string | undefined {
  if (state["End"] === true) return undefined;
  const next = state["Next"];
  if (typeof next !== "string") throw new Error(`${name}: neither Next nor End`);
  return next;
}

function taskCall(state: string, resource: string, args: Record<string, unknown>, taskToken: string | undefined): TaskCall {
  const overrides = (args["Overrides"] as { ContainerOverrides?: Record<string, unknown>[] } | undefined)?.ContainerOverrides ?? [];
  const [container] = overrides;
  const command = (container?.["Command"] as string[] | undefined) ?? [];
  const environment = Object.fromEntries(
    ((container?.["Environment"] as { Name: string; Value: string }[] | undefined) ?? []).map((variable) => [variable.Name, variable.Value]),
  );
  return { state, resource, arguments: args, command, environment, ...(taskToken === undefined ? {} : { taskToken }) };
}

/** The task's result, or a StateError as Step Functions raises it. */
function finish(call: TaskCall, outcome: TaskOutcome): unknown {
  const containerName = ((call.arguments["Overrides"] as { ContainerOverrides?: { Name?: string }[] } | undefined)?.ContainerOverrides ?? [])[0]?.Name;
  const description = (container: Record<string, unknown>, stop: Record<string, unknown>) => ({
    TaskArn: "arn:aws:ecs:eu-central-1:123456789012:task/factory/0123456789abcdef",
    LastStatus: "STOPPED",
    ...stop,
    Containers: [{ Name: containerName, LastStatus: "STOPPED", ...container }],
    Overrides: call.arguments["Overrides"],
  });

  if ("ecsError" in outcome) throw new StateError("ECS.AmazonECSException", outcome.ecsError);
  if ("notStarted" in outcome) {
    const stopped = description(
      { Reason: "CannotPullContainerError: pull image manifest has been retried 5 time(s)" },
      { StopCode: "TaskFailedToStart", StoppedReason: "CannotPullContainerError" },
    );
    throw new StateError("States.TaskFailed", JSON.stringify(stopped));
  }

  if (call.resource === RUN_TASK_WAIT_FOR_TOKEN) {
    if ("success" in outcome) return outcome.success;
    if ("failure" in outcome) throw new StateError(outcome.failure.error, outcome.failure.cause);
    throw new Error(`${call.state}: a waitForTaskToken task ends with success or failure, not ${JSON.stringify(outcome)}`);
  }

  if (!("exit" in outcome)) throw new Error(`${call.state}: a .sync task ends with an exit code, not ${JSON.stringify(outcome)}`);
  const stopped = description({ ExitCode: outcome.exit }, { StopCode: "EssentialContainerExited", StoppedReason: "Essential container in task exited" });
  if (outcome.exit === 0) return stopped;
  throw new StateError("States.TaskFailed", JSON.stringify(stopped));
}

interface Scope {
  input: unknown;
  context: unknown;
  result?: unknown;
  errorOutput?: unknown;
}

/** A JSONata template: `{% … %}` strings are evaluated, other values kept, objects and arrays walked. */
async function evaluate(template: unknown, scope: Scope, variables: Record<string, unknown>): Promise<unknown> {
  if (typeof template === "string") {
    const match = /^\{%([\s\S]*)%\}$/.exec(template);
    if (match === null) return template;
    try {
      const expression = jsonata(match[1] ?? "");
      // Step Functions' own addition to JSONata, which the library lacks.
      expression.registerFunction("parse", (text: string): unknown => JSON.parse(text), "<s:x>");
      return (await expression.evaluate(scope.input, { ...variables, states: scope })) as unknown;
    } catch (error) {
      throw new Error(`evaluating ${template}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  if (Array.isArray(template)) return Promise.all(template.map((item) => evaluate(item, scope, variables)));
  if (typeof template === "object" && template !== null) {
    const entries = await Promise.all(Object.entries(template).map(async ([key, item]) => [key, await evaluate(item, scope, variables)] as const));
    return Object.fromEntries(entries.filter(([, item]) => item !== undefined));
  }
  return template;
}

async function evaluateAssign(assign: unknown, scope: Scope, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (assign === undefined) return {};
  return (await evaluate(assign, scope, variables)) as Record<string, unknown>;
}
