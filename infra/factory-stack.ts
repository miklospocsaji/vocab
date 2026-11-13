/**
 * The factory stack (add-cloud-proposal-run design), in eu-central-1. Never written by factory
 * roles (brief, section 5).
 * - network: public subnets only, in two AZs; no NAT, no private subnets, no endpoints (ADR 0008)
 * - data: the ledger on Aurora Serverless v2 with auto-pause, no public address, reachable
 *   only from the worker's security group, over TLS (ADR 0003)
 * - compute: an ECS cluster and the `factory-worker` Fargate task definition (ADR 0010), plus a
 *   test-only boundary-check task definition: the same in everything but its image, which is
 *   the worker image plus Vitest. The state machine never runs it.
 * - builds (add-build-loop, ADR 0011): the artifact bucket the worker and the build task share,
 *   and the build task definition from the Dockerfile's `build` target, holding only the API key,
 *   with a task role limited to `work-items/*` in the bucket and a security group the ledger does
 *   not admit
 * - orchestration: the work item's Step Functions state machine (JSONata, from `definition()`),
 *   which runs only the worker task definition, and the webhook Lambda behind a Function URL,
 *   outside the VPC and with no access to the ledger (ADR 0002, amendment of 2026-11-06)
 * - budget: a $50 monthly alarm for the whole account
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArnFormat, CfnOutput, Duration, Fn, IgnoreMode, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { Port, SecurityGroup, SubnetType, Vpc, type ISecurityGroup, type ISubnet } from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import {
  Cluster,
  ContainerImage,
  type ContainerDefinitionOptions,
  CpuArchitecture,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
  Secret as EcsSecret,
} from "aws-cdk-lib/aws-ecs";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Architecture, FunctionUrlAuthType, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  ParameterGroup,
} from "aws-cdk-lib/aws-rds";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { DefinitionBody, StateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { definition } from "@vocab/factory-orchestrator/state-machine";
import { WEBHOOK_ENV } from "@vocab/factory-orchestrator/webhook-env";
import type { Construct } from "constructs";

/** The state machine's name, fixed so the worker's task role can name it before it exists. */
export const STATE_MACHINE_NAME = "factory-work-item";
/** The worker Dockerfile's test-only target: the worker image plus Vitest (ADR 0010). */
export const BOUNDARY_CHECK_TARGET = "boundary-check";
/** The worker's container in the task definition, which RunTask overrides name. */
export const WORKER_CONTAINER = "worker";
/** The worker Dockerfile's build container target (ADR 0010, amendment of 2026-11-09). */
export const BUILD_TARGET = "build";
/** The build container in its task definition. */
export const BUILD_CONTAINER = "build";
/** The store prefix the build task may read and write, and everything the worker exchanges with it. */
export const WORK_ITEMS_PREFIX = "work-items/";
/** How long build outputs are kept (design, "Factory stack"). */
const ARTIFACT_RETENTION_DAYS = 180;

/** The SecureString parameters the owner creates with the AWS CLI; the stack only references them. */
export const PARAMETERS = {
  anthropicApiKey: "/factory/anthropic-api-key",
  githubAppPrivateKey: "/factory/github-app-private-key",
  githubWebhookSecret: "/factory/github-webhook-secret",
} as const;

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WORKER_DOCKERFILE = "factory/worker/Dockerfile";
const WEBHOOK_ENTRY = "factory/orchestrator/src/lambda/webhook.ts";
/** The rule Step Functions manages to learn when a `.sync` ECS task stops. */
const ECS_SYNC_RULE = "StepFunctionsGetEventsForECSTaskRule";
const LEDGER_PORT = 5432;
const LEDGER_DATABASE = "factory";
const MONTHLY_BUDGET_USD = 50;

export interface GitHubSettings {
  /** `<owner>/<repo>`. */
  repository: string;
  appId: number;
  installationId: number;
  slug: string;
  /** The only login whose `/approve` counts (ADR 0009). */
  owner: string;
}

export interface FactoryStackProps extends StackProps {
  github: GitHubSettings;
  /** Where the budget alarm emails; deploy-time context, never committed. */
  budgetEmail: string;
}

/** How RunTask places a worker task: public subnets, a public IP, the worker's security group. */
export interface WorkerNetwork {
  subnets: ISubnet[];
  securityGroup: ISecurityGroup;
  assignPublicIp: boolean;
}

export class FactoryStack extends Stack {
  readonly workerNetwork: WorkerNetwork;
  readonly cluster: Cluster;
  readonly taskDefinition: FargateTaskDefinition;
  /** Test only: the worker's settings and roles with the boundary-check image. */
  readonly boundaryCheckTaskDefinition: FargateTaskDefinition;
  /** The build container's task definition, which the state machine's Build state runs. */
  readonly buildTaskDefinition: FargateTaskDefinition;
  readonly artifactBucket: Bucket;
  readonly ledger: DatabaseCluster;
  readonly stateMachine: StateMachine;
  readonly webhook: NodejsFunction;

  constructor(scope: Construct, id: string, props: FactoryStackProps) {
    super(scope, id, props);
    Tags.of(this).add("project", "vocab-factory");

    // Network: public subnets only (ADR 0008). Two AZs, because Aurora's subnet group needs two.
    const vpc = new Vpc(this, "Vpc", {
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
      restrictDefaultSecurityGroup: false,
    });

    const workerSecurityGroup = new SecurityGroup(this, "WorkerSecurityGroup", {
      vpc,
      description: "factory-worker tasks: no inbound access",
      allowAllOutbound: true,
    });
    this.workerNetwork = { subnets: vpc.publicSubnets, securityGroup: workerSecurityGroup, assignPublicIp: true };

    // Data: the ledger, reachable only from the worker, over TLS (ADR 0003).
    const ledgerSecurityGroup = new SecurityGroup(this, "LedgerSecurityGroup", {
      vpc,
      description: "factory ledger: Postgres from the worker only",
      allowAllOutbound: false,
    });
    ledgerSecurityGroup.addIngressRule(workerSecurityGroup, Port.tcp(LEDGER_PORT), "Postgres from factory-worker tasks");

    const engine = DatabaseClusterEngine.auroraPostgres({ version: AuroraPostgresEngineVersion.VER_17_7 });
    this.ledger = new DatabaseCluster(this, "Ledger", {
      engine,
      parameterGroup: new ParameterGroup(this, "LedgerParameters", { engine, parameters: { "rds.force_ssl": "1" } }),
      writer: ClusterInstance.serverlessV2("writer", { publiclyAccessible: false }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      serverlessV2AutoPauseDuration: Duration.minutes(5),
      vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [ledgerSecurityGroup],
      port: LEDGER_PORT,
      credentials: Credentials.fromGeneratedSecret("factory"),
      defaultDatabaseName: LEDGER_DATABASE,
      storageEncrypted: true,
      deletionProtection: true,
      backup: { retention: Duration.days(7) },
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });
    const ledgerSecret = this.ledger.secret;
    if (ledgerSecret === undefined) throw new Error("the ledger has no generated secret");

    // The artifact store between the worker and the build task (ADR 0003, amendment of add-build-loop).
    this.artifactBucket = new Bucket(this, "Artifacts", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      versioned: false,
      lifecycleRules: [{ expiration: Duration.days(ARTIFACT_RETENTION_DAYS) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const workItemObjects = this.artifactBucket.arnForObjects(`${WORK_ITEMS_PREFIX}*`);

    // Compute: the worker (ADR 0010).
    this.cluster = new Cluster(this, "Cluster", { vpc });
    const logGroup = new LogGroup(this, "WorkerLogs", { retention: RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });

    const taskSize = {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: CpuArchitecture.X86_64, operatingSystemFamily: OperatingSystemFamily.LINUX },
    };
    this.taskDefinition = new FargateTaskDefinition(this, "Worker", taskSize);
    // The worker reports to its own state machine's tasks, and nothing else.
    const stateMachineArn = this.formatArn({
      service: "states",
      resource: "stateMachine",
      resourceName: STATE_MACHINE_NAME,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({ actions: ["states:SendTaskFailure", "states:SendTaskSuccess"], resources: [stateMachineArn] }),
    );
    // The worker reads and writes build inputs and outputs. ListBucket on the prefix, so a missing
    // key is a 404 rather than a 403: `step` asks whether an outcome exists.
    this.taskDefinition.addToTaskRolePolicy(new PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [workItemObjects] }));
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [this.artifactBucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": [`${WORK_ITEMS_PREFIX}*`] } },
      }),
    );

    const parameter = (constructId: string, parameterName: string) =>
      StringParameter.fromSecureStringParameterAttributes(this, constructId, { parameterName });

    // Both images from one Dockerfile and one staged context; the check is a target on top of the worker.
    const image = (constructId: string, target?: string) =>
      ContainerImage.fromDockerImageAsset(
        new DockerImageAsset(this, constructId, {
          directory: REPO_ROOT,
          file: WORKER_DOCKERFILE,
          platform: Platform.LINUX_AMD64,
          ...(target === undefined ? {} : { target }),
          // Stage only what the image's own allowlist lets in, so `.env*` never reaches cdk.out.
          exclude: dockerignore(resolve(REPO_ROOT, `${WORKER_DOCKERFILE}.dockerignore`)),
          ignoreMode: IgnoreMode.DOCKER,
        }),
      );

    const anthropicApiKey = EcsSecret.fromSsmParameter(parameter("AnthropicApiKey", PARAMETERS.anthropicApiKey));
    const container: Omit<ContainerDefinitionOptions, "image"> = {
      logging: LogDrivers.awsLogs({ logGroup, streamPrefix: "worker" }),
      environment: {
        FACTORY_AUTH_MODE: "api-key",
        FACTORY_STORE_BUCKET: this.artifactBucket.bucketName,
        FACTORY_GITHUB_REPOSITORY: props.github.repository,
        FACTORY_GITHUB_APP_ID: String(props.github.appId),
        FACTORY_GITHUB_APP_INSTALLATION_ID: String(props.github.installationId),
        FACTORY_GITHUB_APP_SLUG: props.github.slug,
      },
      // Secrets only through `secrets`, injected by ECS at start (ADR 0009).
      secrets: {
        ANTHROPIC_API_KEY: anthropicApiKey,
        FACTORY_GITHUB_APP_PRIVATE_KEY: EcsSecret.fromSsmParameter(parameter("GitHubAppPrivateKey", PARAMETERS.githubAppPrivateKey)),
        FACTORY_LEDGER_SECRET: EcsSecret.fromSecretsManager(ledgerSecret),
      },
    };
    this.taskDefinition.addContainer(WORKER_CONTAINER, { ...container, image: image("WorkerImage") });

    // The boundary check runs as the worker does: the same roles, so the same permissions.
    this.boundaryCheckTaskDefinition = new FargateTaskDefinition(this, "BoundaryCheck", {
      ...taskSize,
      taskRole: this.taskDefinition.taskRole,
      executionRole: this.taskDefinition.obtainExecutionRole(),
    });
    this.boundaryCheckTaskDefinition.addContainer(WORKER_CONTAINER, { ...container, image: image("BoundaryCheckImage", BOUNDARY_CHECK_TARGET) });

    // The build container (ADR 0011): only the API key, only work-items/* in the bucket, and a
    // security group the ledger does not admit. Its own roles, so none of the worker's grants reach it.
    const buildSecurityGroup = new SecurityGroup(this, "BuildSecurityGroup", {
      vpc,
      description: "factory build tasks: no inbound access, and no access to the ledger",
      allowAllOutbound: true,
    });
    this.buildTaskDefinition = new FargateTaskDefinition(this, "Build", {
      cpu: 2048,
      memoryLimitMiB: 4096,
      ephemeralStorageGiB: 30,
      runtimePlatform: taskSize.runtimePlatform,
    });
    this.buildTaskDefinition.addToTaskRolePolicy(new PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [workItemObjects] }));
    this.buildTaskDefinition.addContainer(BUILD_CONTAINER, {
      image: image("BuildImage", BUILD_TARGET),
      logging: LogDrivers.awsLogs({ logGroup, streamPrefix: "build" }),
      environment: { FACTORY_AUTH_MODE: "api-key", FACTORY_STORE_BUCKET: this.artifactBucket.bucketName },
      secrets: { ANTHROPIC_API_KEY: anthropicApiKey },
    });

    // Orchestration: the work item's state machine, which runs the worker and the build task and nothing else (ADR 0002).
    const workerRoleArns = [this.taskDefinition.taskRole.roleArn, this.taskDefinition.obtainExecutionRole().roleArn];
    const buildRoleArns = [this.buildTaskDefinition.taskRole.roleArn, this.buildTaskDefinition.obtainExecutionRole().roleArn];
    const inCluster = { ArnEquals: { "ecs:cluster": this.cluster.clusterArn } };
    // States and `/approve` run the worker's family, which ECS resolves to its latest revision.
    // An execution keeps the definition it started with, and a deploy that changes the image
    // deregisters the old revision, so naming a revision would break a paused execution
    // (exit run 2, 2026-11-08). The policies allow the family at any revision, and nothing else.
    const workerFamilyArn = this.formatArn({ service: "ecs", resource: "task-definition", resourceName: `${this.taskDefinition.family}:*` });
    const stateMachineRole = new Role(this, "StateMachineRole", { assumedBy: new ServicePrincipal("states.amazonaws.com") });
    const buildFamilyArn = this.formatArn({ service: "ecs", resource: "task-definition", resourceName: `${this.buildTaskDefinition.family}:*` });
    stateMachineRole.addToPolicy(new PolicyStatement({ actions: ["ecs:RunTask"], resources: [workerFamilyArn], conditions: inCluster }));
    stateMachineRole.addToPolicy(new PolicyStatement({ actions: ["ecs:RunTask"], resources: [buildFamilyArn], conditions: inCluster }));
    stateMachineRole.addToPolicy(
      new PolicyStatement({
        actions: ["ecs:StopTask", "ecs:DescribeTasks"],
        resources: [this.formatArn({ service: "ecs", resource: "task", resourceName: `${this.cluster.clusterName}/*` })],
      }),
    );
    stateMachineRole.addToPolicy(new PolicyStatement({ actions: ["iam:PassRole"], resources: [...workerRoleArns, ...buildRoleArns] }));
    stateMachineRole.addToPolicy(
      new PolicyStatement({
        actions: ["events:PutTargets", "events:PutRule", "events:DescribeRule"],
        resources: [this.formatArn({ service: "events", resource: "rule", resourceName: ECS_SYNC_RULE })],
      }),
    );
    const workerTask = {
      cluster: this.cluster.clusterArn,
      taskDefinition: this.taskDefinition.family,
      subnets: vpc.publicSubnets.map((subnet) => subnet.subnetId),
      securityGroup: workerSecurityGroup.securityGroupId,
      container: WORKER_CONTAINER,
      build: { taskDefinition: this.buildTaskDefinition.family, securityGroup: buildSecurityGroup.securityGroupId, container: BUILD_CONTAINER },
    };
    this.stateMachine = new StateMachine(this, "StateMachine", {
      stateMachineName: STATE_MACHINE_NAME,
      definitionBody: DefinitionBody.fromString(this.toJsonString(definition(workerTask))),
      role: stateMachineRole,
    });

    // The webhook: outside the VPC, no ledger; it starts executions and approve tasks only.
    this.webhook = new NodejsFunction(this, "Webhook", {
      entry: resolve(REPO_ROOT, WEBHOOK_ENTRY),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // GitHub waits 10 seconds for an answer.
      timeout: Duration.seconds(10),
      logGroup: new LogGroup(this, "WebhookLogs", { retention: RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
      projectRoot: REPO_ROOT,
      depsLockFilePath: resolve(REPO_ROOT, "pnpm-lock.yaml"),
      // The pinned AWS SDK clients go into the bundle, not the runtime's own.
      bundling: { externalModules: [], minify: true, target: "node24" },
      environment: {
        [WEBHOOK_ENV.stateMachineArn]: this.stateMachine.stateMachineArn,
        [WEBHOOK_ENV.repository]: props.github.repository,
        [WEBHOOK_ENV.owner]: props.github.owner,
        [WEBHOOK_ENV.cluster]: workerTask.cluster,
        [WEBHOOK_ENV.taskDefinition]: workerTask.taskDefinition,
        [WEBHOOK_ENV.subnets]: Fn.join(",", workerTask.subnets),
        [WEBHOOK_ENV.securityGroup]: workerTask.securityGroup,
        [WEBHOOK_ENV.container]: WORKER_CONTAINER,
        [WEBHOOK_ENV.secretParameter]: PARAMETERS.githubWebhookSecret,
      },
    });
    this.webhook.addToRolePolicy(new PolicyStatement({ actions: ["states:StartExecution"], resources: [this.stateMachine.stateMachineArn] }));
    this.webhook.addToRolePolicy(new PolicyStatement({ actions: ["ecs:RunTask"], resources: [workerFamilyArn], conditions: inCluster }));
    this.webhook.addToRolePolicy(new PolicyStatement({ actions: ["iam:PassRole"], resources: workerRoleArns }));
    this.webhook.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: PARAMETERS.githubWebhookSecret.slice(1) })],
      }),
    );
    // The signature is checked in code (design, "Webhook Lambda").
    const webhookUrl = this.webhook.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    // Budget: the whole account, which the factory shares (owner decision, 2026-11-02).
    const subscribers = [{ subscriptionType: "EMAIL", address: props.budgetEmail }];
    new CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "account-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
          subscribers,
        },
        {
          notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
          subscribers,
        },
      ],
    });

    // What a one-off RunTask needs (the cloud tests), and the webhook's address for the App's settings.
    new CfnOutput(this, "ClusterArn", { value: this.cluster.clusterArn });
    new CfnOutput(this, "WorkerTaskDefinitionArn", { value: this.taskDefinition.taskDefinitionArn });
    new CfnOutput(this, "BoundaryCheckTaskDefinitionArn", { value: this.boundaryCheckTaskDefinition.taskDefinitionArn });
    new CfnOutput(this, "WorkerContainerName", { value: WORKER_CONTAINER });
    new CfnOutput(this, "BuildTaskDefinitionArn", { value: this.buildTaskDefinition.taskDefinitionArn });
    new CfnOutput(this, "BuildContainerName", { value: BUILD_CONTAINER });
    new CfnOutput(this, "BuildSecurityGroupId", { value: buildSecurityGroup.securityGroupId });
    new CfnOutput(this, "ArtifactBucketName", { value: this.artifactBucket.bucketName });
    new CfnOutput(this, "WorkerSubnetIds", { value: Fn.join(",", vpc.publicSubnets.map((subnet) => subnet.subnetId)) });
    new CfnOutput(this, "WorkerSecurityGroupId", { value: workerSecurityGroup.securityGroupId });
    new CfnOutput(this, "WorkerLogGroupName", { value: logGroup.logGroupName });
    new CfnOutput(this, "StateMachineArn", { value: this.stateMachine.stateMachineArn });
    new CfnOutput(this, "WebhookUrl", { value: webhookUrl.url });
  }
}

/** The patterns of a .dockerignore file, without comments and blank lines. */
function dockerignore(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The stack's settings from the app's context (cdk.json, and `-c budgetEmail=…` at deploy). */
export function factoryContext(scope: Construct): Pick<FactoryStackProps, "github" | "budgetEmail"> {
  const get = (key: string): unknown => scope.node.tryGetContext(key);
  const text = (key: string): string => {
    const value = get(key);
    if (typeof value !== "string" || value.trim() === "") throw new Error(`context ${key} is not set`);
    return value;
  };
  const integer = (key: string): number => {
    const value = Number(get(key));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`context ${key} must be a positive integer`);
    return value;
  };
  const budgetEmail = get("budgetEmail");
  if (typeof budgetEmail !== "string" || !/^[^@\s]+@[^@\s]+$/.test(budgetEmail)) {
    throw new Error("context budgetEmail is not set: pass -c budgetEmail=<address> to cdk");
  }
  return {
    github: {
      repository: text("factory:githubRepository"),
      appId: integer("factory:githubAppId"),
      installationId: integer("factory:githubAppInstallationId"),
      slug: text("factory:githubAppSlug"),
      owner: text("factory:owner"),
    },
    budgetEmail,
  };
}
