/**
 * The webhook Lambda's environment variables, shared by the handler and the stack that sets
 * them. None holds a secret: the webhook secret is read from Parameter Store by name.
 */
export const WEBHOOK_ENV = {
  stateMachineArn: "FACTORY_STATE_MACHINE_ARN",
  repository: "FACTORY_GITHUB_REPOSITORY",
  owner: "FACTORY_OWNER",
  cluster: "FACTORY_CLUSTER_ARN",
  taskDefinition: "FACTORY_WORKER_TASK_DEFINITION_ARN",
  subnets: "FACTORY_WORKER_SUBNET_IDS",
  securityGroup: "FACTORY_WORKER_SECURITY_GROUP_ID",
  container: "FACTORY_WORKER_CONTAINER",
  secretParameter: "FACTORY_WEBHOOK_SECRET_PARAMETER",
} as const;
