/**
 * CDK assertions on the factory stack (add-cloud-proposal-run tasks 2.3 and 3.8, add-build-loop
 * task 4.5), synthesised
 * with bundling skipped. The worker image's build context is staged, but never built, and the
 * webhook Lambda is not bundled.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { WEBHOOK_ENV } from "@vocab/factory-orchestrator/webhook-env";
import { workerConfig } from "@vocab/factory-worker/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOUNDARY_CHECK_TARGET, FactoryStack, PARAMETERS, STATE_MACHINE_NAME, WORKER_CONTAINER } from "../factory-stack.ts";

const ACCOUNT = "123456789012";
const REGION = "eu-central-1";
const BUDGET_EMAIL = "budget@example.com";
const REPO_ROOT = join(import.meta.dirname, "../..");
const GITHUB = { repository: "miklospocsaji/vocab", appId: 5586098, installationId: 177972181, slug: "vocab-factory", owner: "miklospocsaji" };

type Resource = { Type: string; Properties?: Record<string, unknown> };

let outdir: string;
let stack: FactoryStack;
let template: Template;
let resources: Record<string, Resource>;

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "factory-stack-"));
  const app = new App({ outdir, context: { "aws:cdk:bundling-stacks": [] } });
  stack = new FactoryStack(app, "Factory", { env: { account: ACCOUNT, region: REGION }, github: GITHUB, budgetEmail: BUDGET_EMAIL });
  template = Template.fromStack(stack);
  resources = (template.toJSON() as { Resources?: Record<string, Resource> }).Resources ?? {};
});

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

function ofType(type: string): [string, Resource][] {
  return Object.entries(resources).filter(([, resource]) => resource.Type === type);
}

function props(type: string): Record<string, unknown>[] {
  return ofType(type).map(([, resource]) => resource.Properties ?? {});
}

/** The logical id a `{ "Fn::GetAtt": [id, …] }` or `{ Ref: id }` points at. */
function target(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ref = (value as { Ref?: unknown }).Ref;
  if (typeof ref === "string") return ref;
  const getAtt = (value as { "Fn::GetAtt"?: unknown })["Fn::GetAtt"];
  return Array.isArray(getAtt) && typeof getAtt[0] === "string" ? getAtt[0] : undefined;
}

/** The logical id of the security group a stack output names. */
function outputTarget(name: string): string {
  const outputs = template.findOutputs(name);
  const output = Object.values(outputs)[0] as { Value?: unknown } | undefined;
  const id = target(output?.Value);
  if (id === undefined) throw new Error(`output ${name} names no resource`);
  return id;
}

/** Every ingress rule on a security group: inline ones and AWS::EC2::SecurityGroupIngress resources. */
function ingressOf(groupId: string): Record<string, unknown>[] {
  const inline = (resources[groupId]?.Properties?.["SecurityGroupIngress"] as Record<string, unknown>[] | undefined) ?? [];
  const separate = props("AWS::EC2::SecurityGroupIngress").filter((rule) => target(rule["GroupId"]) === groupId);
  return [...inline, ...separate];
}

/** The ledger cluster's one security group. */
function ledgerSecurityGroup(): string {
  const [cluster] = props("AWS::RDS::DBCluster");
  const groups = (cluster?.["VpcSecurityGroupIds"] as unknown[] | undefined) ?? [];
  expect(groups).toHaveLength(1);
  const id = target(groups[0]);
  if (id === undefined) throw new Error("the ledger's security group is not in the stack");
  return id;
}

/** The task definition a stack output names. */
function taskDefinitionOf(output: string): Record<string, unknown> {
  const definition: Resource | undefined = resources[outputTarget(output)];
  if (definition?.Type !== "AWS::ECS::TaskDefinition") throw new Error(`output ${output} names no task definition`);
  return definition.Properties ?? {};
}

function workerContainer(): Record<string, unknown> {
  const taskDefinition = taskDefinitionOf("WorkerTaskDefinitionArn");
  const containers = (taskDefinition["ContainerDefinitions"] as Record<string, unknown>[] | undefined) ?? [];
  const container = containers.find((definition) => definition["Name"] === WORKER_CONTAINER);
  if (container === undefined) throw new Error(`no ${WORKER_CONTAINER} container`);
  return container;
}

/** The policy documents attached to a role, by its logical id. */
function policiesOf(roleId: string): { Statement: Record<string, unknown>[] }[] {
  const inline = ((resources[roleId]?.Properties?.["Policies"] as { PolicyDocument: { Statement: Record<string, unknown>[] } }[] | undefined) ?? []).map(
    (policy) => policy.PolicyDocument,
  );
  const attached = props("AWS::IAM::Policy")
    .filter((policy) => ((policy["Roles"] as unknown[] | undefined) ?? []).some((role) => target(role) === roleId))
    .map((policy) => policy["PolicyDocument"] as { Statement: Record<string, unknown>[] });
  return [...inline, ...attached];
}

describe("factory stack: network and ledger", () => {
  it("Scenario: Ledger is closed to everything but the worker", () => {
    const instances = props("AWS::RDS::DBInstance");
    expect(instances.length).toBeGreaterThan(0);
    for (const instance of instances) expect(instance["PubliclyAccessible"]).toBe(false);

    const worker = outputTarget("WorkerSecurityGroupId");
    expect(ingressOf(ledgerSecurityGroup())).toEqual([
      expect.objectContaining({
        IpProtocol: "tcp",
        FromPort: 5432,
        ToPort: 5432,
        SourceSecurityGroupId: { "Fn::GetAtt": [worker, "GroupId"] },
      }),
    ]);

    // Over TLS: the cluster refuses plain connections.
    const [cluster] = props("AWS::RDS::DBCluster");
    const parameterGroup = resources[target(cluster?.["DBClusterParameterGroupName"]) ?? ""];
    expect(parameterGroup?.Properties?.["Parameters"]).toMatchObject({ "rds.force_ssl": "1" });
  });

  it("has no NAT Gateway, NAT instance, private subnet or VPC endpoint", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::Instance", 0);
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
    template.resourceCountIs("AWS::EC2::VPC", 1);

    // Two public subnets in two AZs, for Aurora's subnet group.
    const subnets = props("AWS::EC2::Subnet");
    expect(subnets).toHaveLength(2);
    for (const subnet of subnets) expect(subnet["MapPublicIpOnLaunch"]).toBe(true);
    expect(new Set(subnets.map((subnet) => JSON.stringify(subnet["AvailabilityZone"]))).size).toBe(2);

    // Every route leads to the internet gateway.
    const routes = props("AWS::EC2::Route");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route).toMatchObject({ DestinationCidrBlock: "0.0.0.0/0", GatewayId: expect.anything() as unknown });
      expect(route).not.toHaveProperty("NatGatewayId");
      expect(route).not.toHaveProperty("InstanceId");
    }
  });

  it("runs Aurora Serverless v2 at 0 to 1 ACU, auto-paused, with deletion protection on", () => {
    template.resourceCountIs("AWS::RDS::DBCluster", 1);
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      EngineVersion: Match.stringLikeRegexp("^17\\."),
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 1, SecondsUntilAutoPause: 300 },
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
      StorageEncrypted: true,
      // Credentials generated into Secrets Manager, never in the template.
      MasterUsername: Match.anyValue(),
      MasterUserPassword: Match.anyValue(),
    });
    // One writer.
    template.resourceCountIs("AWS::RDS::DBInstance", 1);
    template.hasResourceProperties("AWS::RDS::DBInstance", { DBInstanceClass: "db.serverless" });
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });
});

describe("factory stack: worker", () => {
  it("takes secrets through `secrets` only", () => {
    const container = workerContainer();
    const secrets = (container["Secrets"] as { Name: string; ValueFrom: unknown }[] | undefined) ?? [];
    const environment = (container["Environment"] as { Name: string; Value: unknown }[] | undefined) ?? [];

    expect(secrets.map((secret) => secret.Name).sort()).toEqual(["ANTHROPIC_API_KEY", "FACTORY_GITHUB_APP_PRIVATE_KEY", "FACTORY_LEDGER_SECRET"]);
    const valueFrom = (name: string) => JSON.stringify(secrets.find((secret) => secret.Name === name)?.ValueFrom);
    expect(valueFrom("ANTHROPIC_API_KEY")).toContain(`parameter${PARAMETERS.anthropicApiKey}`);
    expect(valueFrom("FACTORY_GITHUB_APP_PRIVATE_KEY")).toContain(`parameter${PARAMETERS.githubAppPrivateKey}`);
    expect(target(secrets.find((secret) => secret.Name === "FACTORY_LEDGER_SECRET")?.ValueFrom)).toBe(ofType("AWS::SecretsManager::SecretTargetAttachment")[0]?.[0]);

    // Configuration only: nothing secret, and nothing that names a secret's value.
    expect(Object.fromEntries(environment.map((variable) => [variable.Name, variable.Value]))).toEqual({
      FACTORY_AUTH_MODE: "api-key",
      FACTORY_GITHUB_REPOSITORY: GITHUB.repository,
      FACTORY_GITHUB_APP_ID: String(GITHUB.appId),
      FACTORY_GITHUB_APP_INSTALLATION_ID: String(GITHUB.installationId),
      FACTORY_GITHUB_APP_SLUG: GITHUB.slug,
      FACTORY_STORE_BUCKET: { Ref: artifactBucket() },
    });

    // The webhook secret is the Lambda's alone (ADR 0009): neither the worker nor its roles name it.
    const taskDefinition = taskDefinitionOf("WorkerTaskDefinitionArn");
    const roles = [target(taskDefinition["TaskRoleArn"]), target(taskDefinition["ExecutionRoleArn"])].map((role) => role ?? "");
    const worker = JSON.stringify([taskDefinition, ...roles.flatMap((role) => policiesOf(role))]);
    expect(worker).not.toContain(PARAMETERS.githubWebhookSecret.slice(1));
  });

  it("gives the worker every variable its configuration needs", () => {
    // Stand-ins for what ECS injects from `secrets` at start; the names come from the template.
    const injected: Record<string, string> = {
      ANTHROPIC_API_KEY: "sk-ant-api-stand-in",
      FACTORY_GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nstand-in\n-----END RSA PRIVATE KEY-----\n",
      FACTORY_LEDGER_SECRET: JSON.stringify({ host: "ledger.example", port: 5432, username: "factory", password: "stand-in", dbname: "factory" }),
    };
    const container = workerContainer();
    const secrets = (container["Secrets"] as { Name: string }[] | undefined) ?? [];
    const environment = (container["Environment"] as { Name: string; Value: unknown }[] | undefined) ?? [];
    const env: Record<string, string> = Object.fromEntries(environment.map((variable) => [variable.Name, String(variable.Value)]));
    for (const { Name } of secrets) {
      const value = injected[Name];
      expect(value, `no stand-in for the secret ${Name}`).toBeDefined();
      env[Name] = value ?? "";
    }

    // The worker's own parser, so a variable the stack fails to pass fails here, not in Fargate.
    const config = workerConfig(env);

    expect(config.ledger.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(config.ledger).not.toHaveProperty("connectionString");
  });

  it("runs the worker image on Fargate, 1 vCPU and 2 GB, linux/amd64", () => {
    template.resourceCountIs("AWS::ECS::Cluster", 1);
    // The worker's, the boundary check's, the build task's and the build boundary check's (below).
    template.resourceCountIs("AWS::ECS::TaskDefinition", 4);
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      RequiresCompatibilities: ["FARGATE"],
      NetworkMode: "awsvpc",
      Cpu: "1024",
      Memory: "2048",
      RuntimePlatform: { CpuArchitecture: "X86_64", OperatingSystemFamily: "LINUX" },
    });
    expect(JSON.stringify(workerContainer()["Image"])).toContain("container-assets");
  });

  it("runs with a public IP and no security group ingress", () => {
    const worker = outputTarget("WorkerSecurityGroupId");
    expect(resources[worker]?.Type).toBe("AWS::EC2::SecurityGroup");
    expect(ingressOf(worker)).toEqual([]);

    // RunTask places the task in the public subnets with a public IP and the worker's group.
    expect(stack.workerNetwork).toMatchObject({ assignPublicIp: true });
    const subnets = ofType("AWS::EC2::Subnet").map(([id]) => ({ Ref: id }));
    expect(stack.resolve(stack.workerNetwork.subnets.map((subnet) => subnet.subnetId))).toEqual(subnets);
    expect(stack.resolve(stack.workerNetwork.securityGroup.securityGroupId)).toEqual({ "Fn::GetAtt": [worker, "GroupId"] });
  });

  it("lets the task role only send task success and failure to this state machine's tasks, and read and write the artifact bucket", () => {
    const taskDefinition = taskDefinitionOf("WorkerTaskDefinitionArn");
    const taskRole = target(taskDefinition["TaskRoleArn"]);
    if (taskRole === undefined) throw new Error("the task definition has no task role");

    const statements = policiesOf(taskRole).flatMap((policy) => policy.Statement);
    expect(statements).toEqual(
      expect.arrayContaining([
        {
          Effect: "Allow",
          Action: ["states:SendTaskFailure", "states:SendTaskSuccess"],
          Resource: {
            "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:states:${REGION}:${ACCOUNT}:stateMachine:${STATE_MACHINE_NAME}`]],
          },
        },
      ]),
    );
    // The bucket: objects under work-items/ read and written, and listed, so a missing key is a 404, not a 403.
    const s3 = statementsOf(taskRole).filter((statement) => statement.Action.some((action) => action.startsWith("s3:")));
    expect(new Set(s3.flatMap((statement) => statement.Action))).toEqual(new Set(["s3:GetObject", "s3:PutObject", "s3:ListBucket"]));
    for (const action of ["s3:GetObject", "s3:PutObject"]) expect(resourcesFor(s3, action)).toEqual([bucketObjects()]);
    expect(resourcesFor(s3, "s3:ListBucket")).toEqual([{ "Fn::GetAtt": [artifactBucket(), "Arn"] }]);
    expect(statements).toHaveLength(1 + s3.length);
    expect(resources[taskRole]?.Properties?.["ManagedPolicyArns"]).toBeUndefined();
  });

  it("lets the execution role read only the worker's parameters and the ledger secret", () => {
    const taskDefinition = taskDefinitionOf("WorkerTaskDefinitionArn");
    const executionRole = target(taskDefinition["ExecutionRoleArn"]);
    if (executionRole === undefined) throw new Error("the task definition has no execution role");

    const statements = policiesOf(executionRole).flatMap((policy) => policy.Statement);
    const reads = statements.filter((statement) => /ssm:|secretsmanager:/.test(JSON.stringify(statement["Action"])));
    const text = JSON.stringify(reads);
    expect(text).toContain(`parameter${PARAMETERS.anthropicApiKey}`);
    expect(text).toContain(`parameter${PARAMETERS.githubAppPrivateKey}`);
    expect(text).not.toContain("parameter/*");
    for (const statement of reads) expect(statement["Resource"]).not.toBe("*");
  });

  it("keeps logs for 14 days", () => {
    const groups = props("AWS::Logs::LogGroup");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group["RetentionInDays"]).toBe(14);
    expect(JSON.stringify(workerContainer()["LogConfiguration"])).toContain("awslogs");
  });

  it("stages only the image's allowlisted files as its build context", () => {
    const staged = readdirSync(outdir).filter((entry) => entry.startsWith("asset.")).map((entry) => join(outdir, entry));
    const contexts = staged.filter((dir) => existsSync(join(dir, "factory/worker/Dockerfile")));
    // The worker's and the boundary check's, both from the same allowlist.
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      const files = readdirSync(context, { recursive: true }).map((file) => relative(context, join(context, String(file))));
      expect(files).toContain("factory/worker/src/main.ts");
      expect(files.filter((file) => /(^|\/)(\.env[^/]*|node_modules|\.git)(\/|$)/.test(file))).toEqual([]);
      expect(files.filter((file) => file.startsWith("docs/") || file.startsWith("app/") || file.startsWith("infra/"))).toEqual([]);
    }
  });
});

/** The docker image assets of the synthesised stack, by their hash. */
function dockerAssets(): Record<string, { source: Record<string, unknown> }> {
  const manifest = JSON.parse(readFileSync(join(outdir, "Factory.assets.json"), "utf8")) as { dockerImages?: Record<string, { source: Record<string, unknown> }> };
  return manifest.dockerImages ?? {};
}

/** The asset hash in a container image URI from `Fn::Sub` / `Fn::Join`. */
function imageHash(container: Record<string, unknown>): string {
  const hash = /:([0-9a-f]{64})/.exec(JSON.stringify(container["Image"]))?.[1];
  if (hash === undefined) throw new Error(`no asset hash in ${JSON.stringify(container["Image"])}`);
  return hash;
}

/** The task definition's one container. */
function onlyContainer(definition: Record<string, unknown>): Record<string, unknown> {
  const containers = (definition["ContainerDefinitions"] as Record<string, unknown>[] | undefined) ?? [];
  expect(containers).toHaveLength(1);
  return containers[0] ?? {};
}

/** Every file of a staged build context with its SHA-256, by path. */
function contextDigest(directory: string): Record<string, string> {
  const root = join(outdir, directory);
  const files = readdirSync(root, { recursive: true }).map(String).filter((file) => statSync(join(root, file)).isFile()).sort();
  expect(files.length).toBeGreaterThan(0);
  return Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")]));
}

function omit(object: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

/** The stages of a Dockerfile: each FROM line and the instructions that follow it. */
function stages(dockerfile: string): { from: string; instructions: string[] }[] {
  const lines = dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const result: { from: string; instructions: string[] }[] = [];
  for (const line of lines) {
    if (/^FROM\s/i.test(line)) result.push({ from: line, instructions: [] });
    else result.at(-1)?.instructions.push(line);
  }
  return result;
}

describe("factory stack: boundary check", () => {
  it("matches the worker's task definition in everything but its image", () => {
    const worker = taskDefinitionOf("WorkerTaskDefinitionArn");
    const check = taskDefinitionOf("BoundaryCheckTaskDefinitionArn");
    expect(outputTarget("BoundaryCheckTaskDefinitionArn")).not.toBe(outputTarget("WorkerTaskDefinitionArn"));

    // The same roles (so the same permissions), size, platform and network mode.
    expect(omit(check, "ContainerDefinitions", "Family")).toEqual(omit(worker, "ContainerDefinitions", "Family"));
    expect(check["TaskRoleArn"]).toEqual(worker["TaskRoleArn"]);
    expect(check["ExecutionRoleArn"]).toEqual(worker["ExecutionRoleArn"]);

    // The same container: name, environment, secrets and logs; only the image differs.
    expect(omit(onlyContainer(check), "Image")).toEqual(omit(onlyContainer(worker), "Image"));
    expect(onlyContainer(check)["Image"]).not.toEqual(onlyContainer(worker)["Image"]);
  });

  it("builds both images from the same Dockerfile and context, the check as a target on top of the worker", () => {
    const assets = dockerAssets();
    const worker = assets[imageHash(onlyContainer(taskDefinitionOf("WorkerTaskDefinitionArn")))]?.source;
    const check = assets[imageHash(onlyContainer(taskDefinitionOf("BoundaryCheckTaskDefinitionArn")))]?.source;
    // The worker's, the boundary check's and the build task's.
    expect(Object.keys(assets)).toHaveLength(3);
    expect(worker).toMatchObject({ dockerFile: "factory/worker/Dockerfile", platform: "linux/amd64" });
    expect(worker).not.toHaveProperty("dockerBuildTarget");
    expect(omit(check ?? {}, "directory")).toEqual({ ...omit(worker ?? {}, "directory"), dockerBuildTarget: BOUNDARY_CHECK_TARGET });
    // CDK stages a copy per asset; the two build contexts hold the same files, byte for byte.
    expect(contextDigest(String(check?.["directory"]))).toEqual(contextDigest(String(worker?.["directory"])));
  });

  it("keeps the worker the Dockerfile's default build, and the check a stage on top of it", () => {
    const all = stages(readFileSync(join(REPO_ROOT, "factory/worker/Dockerfile"), "utf8"));
    const named = (name: string) => all.find((stage) => new RegExp(`\\sAS\\s+${name}$`, "i").test(stage.from));

    // The worker stage, and the check built FROM it, so every layer of the worker is in the check.
    expect(named("worker")).toBeDefined();
    expect(named(BOUNDARY_CHECK_TARGET)?.from).toMatch(new RegExp(`^FROM\\s+worker\\s+AS\\s+${BOUNDARY_CHECK_TARGET}$`, "i"));
    // The last stage is the worker as it is, so a build without a target is the production image.
    expect(all.at(-1)).toEqual({ from: "FROM worker", instructions: [] });
    // The check adds tooling on top, and never changes the worker's code or its user.
    const added = named(BOUNDARY_CHECK_TARGET)?.instructions ?? [];
    expect(added.filter((line) => /^(COPY|ADD)\s/i.test(line))).toEqual([]);
    expect(added.at(-1)).toMatch(/^(ENTRYPOINT|CMD|WORKDIR|USER)/);
    expect(added).toContain("USER factory:factory");
  });
});

describe("factory stack: budget", () => {
  it("alarms at a $50 monthly budget with no cost filter, emailing budgetEmail", () => {
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    const [budget] = props("AWS::Budgets::Budget");
    const definition = budget?.["Budget"] as Record<string, unknown>;
    expect(definition).toMatchObject({ BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 50, Unit: "USD" } });
    expect(definition).not.toHaveProperty("CostFilters");
    expect(definition).not.toHaveProperty("FilterExpression");

    const subscriber = [{ SubscriptionType: "EMAIL", Address: BUDGET_EMAIL }];
    expect(budget?.["NotificationsWithSubscribers"]).toEqual(
      expect.arrayContaining([
        { Notification: { NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: 80, ThresholdType: "PERCENTAGE" }, Subscribers: subscriber },
        { Notification: { NotificationType: "FORECASTED", ComparisonOperator: "GREATER_THAN", Threshold: 100, ThresholdType: "PERCENTAGE" }, Subscribers: subscriber },
      ]),
    );
    expect(budget?.["NotificationsWithSubscribers"]).toHaveLength(2);
  });
});

/** The one resource of a type, with its logical id. */
function only(type: string): [string, Record<string, unknown>] {
  const found = ofType(type);
  expect(found, type).toHaveLength(1);
  const [id, resource] = found[0] ?? ["", { Type: type }];
  return [id, resource.Properties ?? {}];
}

/** Every policy statement of a role, with Action as a list. */
function statementsOf(roleId: string): { Action: string[]; Resource: unknown[]; Condition?: unknown }[] {
  return policiesOf(roleId)
    .flatMap((policy) => policy.Statement)
    .map((statement) => {
      expect(statement["Effect"]).toBe("Allow");
      const action = statement["Action"];
      const resource = statement["Resource"];
      return {
        Action: Array.isArray(action) ? (action as string[]) : [action as string],
        Resource: Array.isArray(resource) ? (resource as unknown[]) : [resource],
        ...(statement["Condition"] === undefined ? {} : { Condition: statement["Condition"] }),
      };
    });
}

/** The resources a role may use an action on. */
function resourcesFor(statements: { Action: string[]; Resource: unknown[] }[], action: string): unknown[] {
  return statements.filter((statement) => statement.Action.includes(action)).flatMap((statement) => statement.Resource);
}

/** The worker task definition's family: what the states and the webhook run, at its latest revision. */
function workerFamily(): string {
  const family = taskDefinitionOf("WorkerTaskDefinitionArn")["Family"];
  if (typeof family !== "string" || family === "") throw new Error("the worker task definition has no literal family");
  return family;
}

/** ecs:RunTask's resources: the worker's family at any revision, and nothing that names a revision. */
function expectWorkerFamilyOnly(resources: unknown[]): void {
  expect(resources).toHaveLength(1);
  const text = JSON.stringify(resources[0]);
  expect(text).toContain(`:task-definition/${workerFamily()}:*`);
  expect(target(resources[0])).toBeUndefined();
  expect(text).not.toContain(outputTarget("WorkerTaskDefinitionArn"));
  expect(text).not.toContain(String(taskDefinitionOf("BoundaryCheckTaskDefinitionArn")["Family"]));
}

function workerRoles(): string[] {
  const taskDefinition = taskDefinitionOf("WorkerTaskDefinitionArn");
  return [target(taskDefinition["TaskRoleArn"]), target(taskDefinition["ExecutionRoleArn"])].map((role) => role ?? "");
}

describe("factory stack: webhook Lambda", () => {
  it("has a Function URL and no VPC configuration", () => {
    const [functionId, fn] = only("AWS::Lambda::Function");
    expect(fn["Runtime"]).toBe("nodejs24.x");
    expect(fn).not.toHaveProperty("VpcConfig");
    // GitHub waits 10 seconds for an answer.
    expect(Number(fn["Timeout"])).toBeLessThanOrEqual(10);

    const [, url] = only("AWS::Lambda::Url");
    expect(url["AuthType"]).toBe("NONE");
    expect(target(url["TargetFunctionArn"])).toBe(functionId);
    expect(template.findOutputs("WebhookUrl")).not.toEqual({});
  });

  it("is configured by name and reference only, with no secret in its environment", () => {
    const [, fn] = only("AWS::Lambda::Function");
    const variables = (fn["Environment"] as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {};
    expect(Object.keys(variables).filter((name) => name !== "NODE_OPTIONS" && name !== "AWS_NODEJS_CONNECTION_REUSE_ENABLED").sort()).toEqual(
      Object.values(WEBHOOK_ENV).sort(),
    );
    expect(variables[WEBHOOK_ENV.owner]).toBe(GITHUB.owner);
    expect(variables[WEBHOOK_ENV.repository]).toBe(GITHUB.repository);
    expect(variables[WEBHOOK_ENV.secretParameter]).toBe(PARAMETERS.githubWebhookSecret);
    expect(variables[WEBHOOK_ENV.container]).toBe(WORKER_CONTAINER);
    expect(target(variables[WEBHOOK_ENV.stateMachineArn])).toBe(only("AWS::StepFunctions::StateMachine")[0]);
    // The family, so `/approve` runs the latest revision (exit run 2: a deploy deregistered the pinned one).
    expect(variables[WEBHOOK_ENV.taskDefinition]).toBe(workerFamily());
    expect(JSON.stringify(variables)).not.toMatch(/secretsmanager|SecretTargetAttachment/i);
  });

  it("lets its role only start this state machine, run the worker, pass its roles and read the webhook secret", () => {
    const [, fn] = only("AWS::Lambda::Function");
    const role = target(fn["Role"]) ?? "";
    const statements = statementsOf(role);

    expect(new Set(statements.flatMap((statement) => statement.Action))).toEqual(
      new Set(["states:StartExecution", "ecs:RunTask", "iam:PassRole", "ssm:GetParameter"]),
    );
    expect(resourcesFor(statements, "states:StartExecution").map(target)).toEqual([only("AWS::StepFunctions::StateMachine")[0]]);
    expectWorkerFamilyOnly(resourcesFor(statements, "ecs:RunTask"));
    expect(new Set(resourcesFor(statements, "iam:PassRole").map(target))).toEqual(new Set(workerRoles()));
    const parameters = resourcesFor(statements, "ssm:GetParameter");
    expect(parameters).toHaveLength(1);
    expect(JSON.stringify(parameters[0])).toContain(`parameter${PARAMETERS.githubWebhookSecret}`);

    // RunTask only in the factory's cluster.
    const runTask = statements.find((statement) => statement.Action.includes("ecs:RunTask"));
    expect(JSON.stringify(runTask?.Condition)).toContain(outputTarget("ClusterArn"));

    // No access to the ledger's secret, and nothing on `*` but the basic Lambda logging policy.
    const text = JSON.stringify(policiesOf(role));
    expect(text).not.toMatch(/secretsmanager:/);
    expect(text).not.toContain(ofType("AWS::SecretsManager::Secret")[0]?.[0] ?? "no-secret");
    for (const statement of statements) expect(statement.Resource).not.toContain("*");
    expect(JSON.stringify(resources[role]?.Properties?.["ManagedPolicyArns"] ?? [])).toContain("AWSLambdaBasicExecutionRole");
    expect((resources[role]?.Properties?.["ManagedPolicyArns"] as unknown[] | undefined) ?? []).toHaveLength(1);
  });
});

describe("factory stack: state machine", () => {
  it("is the JSONata definition, named as the worker's task role expects", () => {
    const [, machine] = only("AWS::StepFunctions::StateMachine");
    expect(machine["StateMachineName"]).toBe(STATE_MACHINE_NAME);
    expect(machine["StateMachineType"] ?? "STANDARD").toBe("STANDARD");
    const definition = JSON.stringify(machine["DefinitionString"]);
    expect(definition).toContain('\\"QueryLanguage\\":\\"JSONata\\"');
    expect(definition).not.toContain(outputTarget("BoundaryCheckTaskDefinitionArn"));
    expect(template.findOutputs("StateMachineArn")).not.toEqual({});
  });

  it("names the worker's task definition family, never a revision, so a paused execution survives a deploy", () => {
    // Exit run 2: an execution keeps the definition it started with, and a deploy that changes
    // the image deregisters the old revision, so a revision in the definition breaks Approved.
    const [, machine] = only("AWS::StepFunctions::StateMachine");
    const definition = JSON.stringify(machine["DefinitionString"]);
    expect(definition).toContain(`\\"TaskDefinition\\":\\"${workerFamily()}\\"`);
    expect(definition).toContain(`\\"TaskDefinition\\":\\"${buildFamily()}\\"`);
    expect(definition).not.toContain(outputTarget("WorkerTaskDefinitionArn"));
    expect(definition).not.toContain(outputTarget("BuildTaskDefinitionArn"));
    expect(definition).not.toMatch(/task-definition\//);
  });

  it("may run only the worker and build task definitions and pass only their roles", () => {
    const [, machine] = only("AWS::StepFunctions::StateMachine");
    const role = target(machine["RoleArn"]) ?? "";
    const statements = statementsOf(role);

    expect(new Set(statements.flatMap((statement) => statement.Action))).toEqual(
      new Set(["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "iam:PassRole", "events:PutTargets", "events:PutRule", "events:DescribeRule"]),
    );
    // Each family at any revision, in the factory's cluster, and nothing else.
    const runTask = resourcesFor(statements, "ecs:RunTask").map((resource) => JSON.stringify(resource));
    expect(runTask).toHaveLength(2);
    expect(runTask.filter((text) => text.includes(`:task-definition/${workerFamily()}:*`))).toHaveLength(1);
    expect(runTask.filter((text) => text.includes(`:task-definition/${buildFamily()}:*`))).toHaveLength(1);
    for (const text of runTask) expect(text).not.toContain(String(taskDefinitionOf("BoundaryCheckTaskDefinitionArn")["Family"]));
    for (const text of runTask) expect(text).not.toContain(String(taskDefinitionOf("BuildBoundaryCheckTaskDefinitionArn")["Family"]));
    for (const statement of statements.filter((s) => s.Action.includes("ecs:RunTask"))) expect(JSON.stringify(statement.Condition)).toContain(outputTarget("ClusterArn"));
    expect(new Set(resourcesFor(statements, "iam:PassRole").map(target))).toEqual(new Set([...workerRoles(), ...buildRoles()]));
    // StopTask and DescribeTasks for the `.sync` integration, on the factory cluster's tasks only.
    for (const action of ["ecs:StopTask", "ecs:DescribeTasks"]) {
      for (const resource of resourcesFor(statements, action)) {
        expect(resource).not.toBe("*");
        expect(JSON.stringify(resource)).toContain(":task/");
      }
    }
    // The managed rule Step Functions uses to wait for ECS tasks.
    for (const action of ["events:PutTargets", "events:PutRule", "events:DescribeRule"]) {
      expect(JSON.stringify(resourcesFor(statements, action))).toContain("rule/StepFunctionsGetEventsForECSTaskRule");
    }
    expect(JSON.stringify(policiesOf(role))).not.toContain(outputTarget("BoundaryCheckTaskDefinitionArn"));
    expect(resources[role]?.Properties?.["ManagedPolicyArns"]).toBeUndefined();
  });
});

/** The artifact bucket's logical id, from the stack output. */
function artifactBucket(): string {
  const id = outputTarget("ArtifactBucketName");
  if (resources[id]?.Type !== "AWS::S3::Bucket") throw new Error("ArtifactBucketName names no bucket");
  return id;
}

/** `<bucket ARN>/work-items/*`, as CDK writes it. */
function bucketObjects(): unknown {
  return { "Fn::Join": ["", [{ "Fn::GetAtt": [artifactBucket(), "Arn"] }, "/work-items/*"]] };
}

function buildFamily(): string {
  const family = taskDefinitionOf("BuildTaskDefinitionArn")["Family"];
  if (typeof family !== "string" || family === "") throw new Error("the build task definition has no literal family");
  return family;
}

function buildRoles(): string[] {
  const taskDefinition = taskDefinitionOf("BuildTaskDefinitionArn");
  return [target(taskDefinition["TaskRoleArn"]), target(taskDefinition["ExecutionRoleArn"])].map((role) => role ?? "");
}

describe("factory stack: artifact bucket", () => {
  it("blocks public access, refuses requests without TLS, and expires objects after 180 days", () => {
    template.resourceCountIs("AWS::S3::Bucket", 1);
    const bucket = resources[artifactBucket()] as Resource & { DeletionPolicy?: string };
    expect(bucket.Properties?.["PublicAccessBlockConfiguration"]).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties?.["BucketEncryption"]).toEqual({ ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] });
    expect(bucket.Properties?.["VersioningConfiguration"]).toBeUndefined();
    expect(bucket.Properties?.["LifecycleConfiguration"]).toEqual({ Rules: [expect.objectContaining({ ExpirationInDays: 180, Status: "Enabled" })] });
    expect(bucket.DeletionPolicy).toBe("Retain");

    const [policy] = props("AWS::S3::BucketPolicy");
    expect(target(policy?.["Bucket"])).toBe(artifactBucket());
    const statements = (policy?.["PolicyDocument"] as { Statement: Record<string, unknown>[] }).Statement;
    expect(statements).toContainEqual(
      expect.objectContaining({ Effect: "Deny", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } }, Principal: { AWS: "*" } }),
    );
  });
});

describe("factory stack: build task", () => {
  it("Scenario: Build task cannot reach the factory's secrets", () => {
    const taskDefinition = taskDefinitionOf("BuildTaskDefinitionArn");
    const container = onlyContainer(taskDefinition);

    // The only secret is the API key.
    const secrets = (container["Secrets"] as { Name: string; ValueFrom: unknown }[] | undefined) ?? [];
    expect(secrets.map((secret) => secret.Name)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(secrets[0]?.ValueFrom)).toContain(`parameter${PARAMETERS.anthropicApiKey}`);
    const environment = (container["Environment"] as { Name: string; Value: unknown }[] | undefined) ?? [];
    expect(Object.fromEntries(environment.map((variable) => [variable.Name, variable.Value]))).toEqual({
      FACTORY_AUTH_MODE: "api-key",
      FACTORY_STORE_BUCKET: { Ref: artifactBucket() },
      NODE_OPTIONS: "--max-old-space-size=4096",
    });

    // Its task role allows only GetObject and PutObject on work-items/* in the artifact bucket.
    const [taskRole, executionRole] = buildRoles();
    expect(taskRole).not.toBe("");
    expect(workerRoles()).not.toContain(taskRole);
    expect(workerRoles()).not.toContain(executionRole);
    expect(statementsOf(taskRole ?? "")).toEqual([{ Action: ["s3:GetObject", "s3:PutObject"], Resource: [bucketObjects()] }]);
    expect(resources[taskRole ?? ""]?.Properties?.["ManagedPolicyArns"]).toBeUndefined();

    // Its execution role reads the API key parameter, and no other parameter or secret.
    const reads = statementsOf(executionRole ?? "").filter((statement) => statement.Action.some((action) => /^(ssm|secretsmanager|kms):/.test(action)));
    const text = JSON.stringify(reads);
    expect(text).toContain(`parameter${PARAMETERS.anthropicApiKey}`);
    expect(text).not.toContain(PARAMETERS.githubAppPrivateKey.slice(1));
    expect(text).not.toContain(PARAMETERS.githubWebhookSecret.slice(1));
    expect(text).not.toMatch(/secretsmanager:/);
    expect(text).not.toContain(ofType("AWS::SecretsManager::Secret")[0]?.[0] ?? "no-secret");
    for (const statement of reads) expect(statement.Resource).not.toContain("*");

    // The ledger admits the worker only: no rule for the build task's security group.
    const build = outputTarget("BuildSecurityGroupId");
    expect(resources[build]?.Type).toBe("AWS::EC2::SecurityGroup");
    expect(build).not.toBe(outputTarget("WorkerSecurityGroupId"));
    expect(JSON.stringify(ingressOf(ledgerSecurityGroup()))).not.toContain(build);
  });

  it("has a security group with no ingress and all egress", () => {
    const build = outputTarget("BuildSecurityGroupId");
    expect(ingressOf(build)).toEqual([]);
    expect(resources[build]?.Properties?.["SecurityGroupEgress"]).toEqual([expect.objectContaining({ CidrIp: "0.0.0.0/0", IpProtocol: "-1" })]);
  });

  it("runs the Dockerfile's build target on Fargate, 2 vCPU, 8 GB and 30 GB of storage, linux/amd64, logging for 14 days", () => {
    const taskDefinition = taskDefinitionOf("BuildTaskDefinitionArn");
    expect(taskDefinition).toMatchObject({
      RequiresCompatibilities: ["FARGATE"],
      NetworkMode: "awsvpc",
      Cpu: "2048",
      Memory: "8192",
      EphemeralStorage: { SizeInGiB: 30 },
      RuntimePlatform: { CpuArchitecture: "X86_64", OperatingSystemFamily: "LINUX" },
    });
    const container = onlyContainer(taskDefinition);
    expect(JSON.stringify(container["LogConfiguration"])).toContain("awslogs");

    const assets = dockerAssets();
    const worker = assets[imageHash(onlyContainer(taskDefinitionOf("WorkerTaskDefinitionArn")))]?.source;
    const buildImage = assets[imageHash(container)]?.source;
    expect(omit(buildImage ?? {}, "directory")).toEqual({ ...omit(worker ?? {}, "directory"), dockerBuildTarget: "build" });
    expect(contextDigest(String(buildImage?.["directory"]))).toEqual(contextDigest(String(worker?.["directory"])));
  });

  it("Scenario: Build task has room for its checks and writes no core dumps", () => {
    const taskDefinition = taskDefinitionOf("BuildTaskDefinitionArn");
    expect(taskDefinition["Memory"]).toBe("8192");
    const container = onlyContainer(taskDefinition);
    const environment = (container["Environment"] as { Name: string; Value: unknown }[] | undefined) ?? [];
    expect(environment).toContainEqual({ Name: "NODE_OPTIONS", Value: "--max-old-space-size=4096" });
    expect(container["Ulimits"]).toEqual([{ Name: "core", SoftLimit: 0, HardLimit: 0 }]);
  });

  it("cannot be run by the webhook", () => {
    const [, fn] = only("AWS::Lambda::Function");
    const webhook = JSON.stringify(policiesOf(target(fn["Role"]) ?? ""));
    expect(webhook).not.toContain(buildFamily());
    for (const role of buildRoles()) expect(webhook).not.toContain(role);
  });
});

describe("factory stack: build boundary check", () => {
  it("matches the build task definition in everything but its entry point and command, with the same image", () => {
    const build = taskDefinitionOf("BuildTaskDefinitionArn");
    const check = taskDefinitionOf("BuildBoundaryCheckTaskDefinitionArn");
    expect(outputTarget("BuildBoundaryCheckTaskDefinitionArn")).not.toBe(outputTarget("BuildTaskDefinitionArn"));

    // The same roles (so the same permissions), size, storage, platform and network mode.
    expect(omit(check, "ContainerDefinitions", "Family")).toEqual(omit(build, "ContainerDefinitions", "Family"));
    expect(check["TaskRoleArn"]).toEqual(build["TaskRoleArn"]);
    expect(check["ExecutionRoleArn"]).toEqual(build["ExecutionRoleArn"]);

    // The same container and image; only the entry point differs, so a command override can run Vitest.
    const checkContainer = onlyContainer(check);
    const buildContainer = onlyContainer(build);
    expect(omit(checkContainer, "EntryPoint", "Command")).toEqual(omit(buildContainer, "EntryPoint", "Command"));
    expect(checkContainer["Image"]).toEqual(buildContainer["Image"]);
    expect(buildContainer["EntryPoint"]).toBeUndefined();
    expect(checkContainer["EntryPoint"]).toEqual(["sh", "-c"]);
    // With no override it refuses to run, and never prints its environment.
    expect(checkContainer["Command"]).toHaveLength(1);
    expect(String((checkContainer["Command"] as unknown[])[0])).toMatch(/exit 2/);
    expect(String((checkContainer["Command"] as unknown[])[0])).not.toMatch(/\benv\b|printenv|\bset\b/);
  });

  it("is never run by the state machine or the webhook", () => {
    const family = String(taskDefinitionOf("BuildBoundaryCheckTaskDefinitionArn")["Family"]);
    const [, machine] = only("AWS::StepFunctions::StateMachine");
    expect(JSON.stringify(machine["DefinitionString"])).not.toContain(family);
    const [, fn] = only("AWS::Lambda::Function");
    expect(JSON.stringify(policiesOf(target(fn["Role"]) ?? ""))).not.toContain(family);
  });
});
