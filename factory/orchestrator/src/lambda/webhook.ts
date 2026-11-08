/**
 * The GitHub webhook behind the Lambda's Function URL (add-cloud-proposal-run design, "Webhook
 * Lambda"). It needs no ledger and no VPC, and answers well within GitHub's 10 seconds even
 * when Aurora is paused.
 *
 * - `X-Hub-Signature-256` is checked against the App's webhook secret, in constant time: 401 on
 *   any mismatch. The secret is read from Parameter Store once per cold start and never logged.
 * - `issues.labeled` with `factory` on an open issue of this repository: one StartExecution,
 *   named `issue-<n>-<delivery id>`, with input `{ issueNumber }` only. 202.
 * - `issue_comment.created` on an issue (not a pull request) whose first line is `/approve`, by
 *   the owner: one RunTask of `approve --issue <n> --by <login>`. 202.
 * - Anything else: 204, doing nothing. A non-owner's `/approve` shows only in the log.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ECSClient, RunTaskCommand, type RunTaskCommandInput } from "@aws-sdk/client-ecs";
import { SFNClient, StartExecutionCommand, type StartExecutionCommandInput } from "@aws-sdk/client-sfn";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { WorkerTaskConfig } from "../state-machine.ts";
import { WEBHOOK_ENV } from "./webhook-env.ts";

export interface WebhookConfig {
  stateMachineArn: string;
  /** `<owner>/<repo>`: deliveries for any other repository are ignored. */
  repository: string;
  /** The only login whose `/approve` counts (ADR 0009). */
  owner: string;
  worker: WorkerTaskConfig;
}

export interface WebhookDeps {
  config: WebhookConfig;
  /** Reads the webhook secret from Parameter Store; called once per cold start. */
  readSecret: () => Promise<string>;
  startExecution: (input: StartExecutionCommandInput) => Promise<void>;
  runTask: (input: RunTaskCommandInput) => Promise<void>;
  log?: (line: string) => void;
}

/** The parts of a Lambda Function URL event the handler reads. */
export interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  body?: string;
}

export const LABEL = "factory";
export const APPROVE_COMMAND = "/approve";

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
/** Step Functions execution names: at most 80 of these characters. */
const NAME_LIMIT = 80;

const answer = (statusCode: number, body: string): FunctionUrlResult => ({ statusCode, body });

/** The handler for one cold start: the secret is read on first use and kept once read. */
export function createWebhookHandler(deps: WebhookDeps): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  const log =
    deps.log ??
    ((line: string) => {
      console.log(line);
    });
  let secret: Promise<string> | undefined;
  const webhookSecret = (): Promise<string> => {
    secret ??= deps.readSecret().catch((error: unknown) => {
      // A failed read is not kept, so the next delivery tries again.
      secret = undefined;
      throw error;
    });
    return secret;
  };

  return async (event) => {
    const headers = lowerCaseKeys(event.headers ?? {});
    const deliveryId = headers["x-github-delivery"] ?? "";
    const eventName = headers["x-github-event"] ?? "";
    const body = Buffer.from(event.body ?? "", event.isBase64Encoded === true ? "base64" : "utf8");

    let key: string;
    try {
      key = await webhookSecret();
    } catch (error) {
      log(`webhook: delivery ${deliveryId}: reading the webhook secret failed: ${errorName(error)}`);
      return answer(500, "webhook secret unavailable");
    }
    if (!signatureMatches(body, headers["x-hub-signature-256"], key)) {
      log(`webhook: delivery ${deliveryId}: signature does not match; rejected`);
      return answer(401, "invalid signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      log(`webhook: delivery ${deliveryId}: body is not JSON`);
      return answer(400, "body is not JSON");
    }

    const action = route(eventName, payload, deps.config);
    switch (action.kind) {
      case "invalid":
        log(`webhook: delivery ${deliveryId} (${eventName}): ${action.reason}`);
        return answer(400, action.reason);
      case "ignore":
        log(`webhook: delivery ${deliveryId} (${eventName}): ignored: ${action.reason}`);
        return answer(204, "");
      case "start": {
        const name = executionName(action.issueNumber, deliveryId);
        try {
          await deps.startExecution({
            stateMachineArn: deps.config.stateMachineArn,
            name,
            input: JSON.stringify({ issueNumber: action.issueNumber }),
          });
        } catch (error) {
          // A redelivery of the same delivery: its execution exists already.
          if (errorName(error) !== "ExecutionAlreadyExists") {
            log(`webhook: delivery ${deliveryId}: starting execution ${name} failed: ${errorName(error)}`);
            return answer(502, "could not start the execution");
          }
          log(`webhook: delivery ${deliveryId}: execution ${name} exists already`);
          return answer(202, "execution exists");
        }
        log(`webhook: delivery ${deliveryId}: started execution ${name} for issue #${String(action.issueNumber)}`);
        return answer(202, "execution started");
      }
      case "approve": {
        try {
          await deps.runTask(approveTask(deps.config.worker, action.issueNumber, action.login));
        } catch (error) {
          log(`webhook: delivery ${deliveryId}: starting approve for issue #${String(action.issueNumber)} failed: ${errorName(error)}`);
          return answer(502, "could not start the approval");
        }
        log(`webhook: delivery ${deliveryId}: started approve for issue #${String(action.issueNumber)} by ${action.login}`);
        return answer(202, "approval started");
      }
    }
  };
}

/** Whether `header` is the body's HMAC-SHA256 under `key`, compared in constant time. */
function signatureMatches(body: Buffer, header: string | undefined, key: string): boolean {
  const hex = SIGNATURE.exec(header ?? "")?.[1];
  if (hex === undefined) return false;
  const expected = createHmac("sha256", key).update(body).digest();
  return timingSafeEqual(Buffer.from(hex, "hex"), expected);
}

type Action =
  | { kind: "start"; issueNumber: number }
  | { kind: "approve"; issueNumber: number; login: string }
  | { kind: "ignore"; reason: string }
  | { kind: "invalid"; reason: string };

/** What a verified delivery asks for. Only the fields named here are read from the payload. */
function route(eventName: string, payload: unknown, config: WebhookConfig): Action {
  if (eventName !== "issues" && eventName !== "issue_comment") return { kind: "ignore", reason: `event ${eventName || "(none)"}` };
  const delivery = asRecord(payload);
  const repository = asRecord(delivery["repository"])["full_name"];
  if (repository !== config.repository) return { kind: "ignore", reason: "another repository" };
  const issue = asRecord(delivery["issue"]);
  const issueNumber = issue["number"];
  if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) return { kind: "invalid", reason: "no issue number" };
  if ("pull_request" in issue && issue["pull_request"] != null) return { kind: "ignore", reason: "a pull request" };
  const action = delivery["action"];

  if (eventName === "issues") {
    if (action !== "labeled") return { kind: "ignore", reason: `issues.${String(action)}` };
    if (asRecord(delivery["label"])["name"] !== LABEL) return { kind: "ignore", reason: "another label" };
    if (issue["state"] !== "open") return { kind: "ignore", reason: "a closed issue" };
    return { kind: "start", issueNumber };
  }

  if (action !== "created") return { kind: "ignore", reason: `issue_comment.${String(action)}` };
  const comment = asRecord(delivery["comment"]);
  const text = comment["body"];
  const firstLine = typeof text === "string" ? (text.split(/\r?\n/)[0] ?? "").trim() : "";
  if (firstLine !== APPROVE_COMMAND) return { kind: "ignore", reason: "not /approve" };
  const login = asRecord(comment["user"])["login"];
  if (typeof login !== "string" || login.toLowerCase() !== config.owner.toLowerCase()) {
    return { kind: "ignore", reason: `/approve from ${typeof login === "string" ? login : "an unknown user"}, who is not the owner` };
  }
  return { kind: "approve", issueNumber, login: config.owner };
}

/** `issue-<n>-<delivery id>`, kept to the characters and length Step Functions allows. */
function executionName(issueNumber: number, deliveryId: string): string {
  const prefix = `issue-${String(issueNumber)}-`;
  const id = deliveryId.replace(/[^A-Za-z0-9_-]/g, "-") || "unknown";
  return `${prefix}${id}`.slice(0, NAME_LIMIT);
}

function approveTask(worker: WorkerTaskConfig, issueNumber: number, login: string): RunTaskCommandInput {
  return {
    cluster: worker.cluster,
    taskDefinition: worker.taskDefinition,
    launchType: "FARGATE",
    networkConfiguration: { awsvpcConfiguration: { subnets: worker.subnets, securityGroups: [worker.securityGroup], assignPublicIp: "ENABLED" } },
    overrides: { containerOverrides: [{ name: worker.container, command: ["approve", "--issue", String(issueNumber), "--by", login] }] },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function lowerCaseKeys(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** An error's name only: AWS SDK errors are named by their code, and messages may echo inputs. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/** The Lambda's configuration from its environment, set by the stack. */
export function webhookConfigFromEnv(env: Record<string, string | undefined>): WebhookConfig & { secretParameter: string } {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") throw new Error(`${name} is not set`);
    return value;
  };
  return {
    stateMachineArn: required(WEBHOOK_ENV.stateMachineArn),
    repository: required(WEBHOOK_ENV.repository),
    owner: required(WEBHOOK_ENV.owner),
    worker: {
      cluster: required(WEBHOOK_ENV.cluster),
      taskDefinition: required(WEBHOOK_ENV.taskDefinition),
      subnets: required(WEBHOOK_ENV.subnets).split(",").map((subnet) => subnet.trim()),
      securityGroup: required(WEBHOOK_ENV.securityGroup),
      container: required(WEBHOOK_ENV.container),
    },
    secretParameter: required(WEBHOOK_ENV.secretParameter),
  };
}

/** The real handler, built on the first invocation of a cold start. */
let real: ((event: FunctionUrlEvent) => Promise<FunctionUrlResult>) | undefined;

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  real ??= realHandler();
  return real(event);
}

function realHandler(): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  const { secretParameter, ...config } = webhookConfigFromEnv(process.env);
  const ssm = new SSMClient({});
  const sfn = new SFNClient({});
  const ecs = new ECSClient({});
  return createWebhookHandler({
    config,
    async readSecret() {
      const { Parameter } = await ssm.send(new GetParameterCommand({ Name: secretParameter, WithDecryption: true }));
      const value = Parameter?.Value;
      if (value === undefined || value === "") throw new Error(`parameter ${secretParameter} is empty`);
      return value;
    },
    async startExecution(input) {
      await sfn.send(new StartExecutionCommand(input));
    },
    async runTask(input) {
      const { tasks, failures } = await ecs.send(new RunTaskCommand(input));
      // RunTask reports capacity and similar failures in its response, not as an error.
      if ((failures ?? []).length > 0 || (tasks ?? []).length === 0) {
        throw Object.assign(new Error("RunTask started no task"), { name: `RunTask:${failures?.[0]?.reason ?? "no task"}` });
      }
    },
  });
}
