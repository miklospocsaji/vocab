/**
 * CDK assertions on the factory stack (add-cloud-proposal-run task 2.3), synthesised with
 * bundling skipped. The worker image's build context is staged, but never built.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
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
    });

    // The webhook secret is the Lambda's alone (ADR 0009).
    expect(JSON.stringify(template.toJSON())).not.toContain(PARAMETERS.githubWebhookSecret.slice(1));
  });

  it("runs the worker image on Fargate, 1 vCPU and 2 GB, linux/amd64", () => {
    template.resourceCountIs("AWS::ECS::Cluster", 1);
    // The worker's, and the boundary check's (below).
    template.resourceCountIs("AWS::ECS::TaskDefinition", 2);
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

  it("lets the task role only send task success and failure to this state machine's tasks", () => {
    const taskDefinition = taskDefinitionOf("WorkerTaskDefinitionArn");
    const taskRole = target(taskDefinition["TaskRoleArn"]);
    if (taskRole === undefined) throw new Error("the task definition has no task role");

    const statements = policiesOf(taskRole).flatMap((policy) => policy.Statement);
    expect(statements).toEqual([
      {
        Effect: "Allow",
        Action: ["states:SendTaskFailure", "states:SendTaskSuccess"],
        Resource: {
          "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:states:${REGION}:${ACCOUNT}:stateMachine:${STATE_MACHINE_NAME}`]],
        },
      },
    ]);
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
    expect(Object.keys(assets)).toHaveLength(2);
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
