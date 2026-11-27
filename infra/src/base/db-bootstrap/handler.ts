import { DatabaseResumingException, ExecuteStatementCommand, RDSDataClient } from "@aws-sdk/client-rds-data";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { bootstrapStatements, runBootstrap } from "./statements.ts";

// The database bootstrap custom resource of VocabShared (ADR 0007), behind the CDK
// `Provider` framework. It runs with the cluster's master secret, so it is standalone: it
// imports nothing from app/*, and only the owner's base deploys change it.
//
// It never logs the event's secrets or any SQL, and errors it raises carry neither.

const PHYSICAL_ID = "database-bootstrap";
const RESUME_TIMEOUT_MS = 120_000;

/** The part of a CloudFormation custom resource event the handler reads. */
export type BootstrapEvent =
  | { readonly RequestType: "Create"; readonly ResourceProperties: object }
  | { readonly RequestType: "Update" | "Delete"; readonly ResourceProperties: object; readonly PhysicalResourceId: string };

export interface BootstrapProperties {
  readonly ClusterArn: string;
  readonly MasterSecretArn: string;
  readonly Databases: readonly { readonly Name: string; readonly SecretArn: string }[];
}

export interface BootstrapDeps {
  readonly rds: { send(command: ExecuteStatementCommand): Promise<{ formattedRecords?: string | undefined }> };
  readonly secrets: { send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined }> };
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Reads an environment's secret, which must belong to the user named like its database. */
async function readPassword(deps: BootstrapDeps, name: string, secretArn: string): Promise<string | undefined> {
  const output = await deps.secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  let value: unknown;
  try {
    value = JSON.parse(output.SecretString ?? "");
  } catch {
    throw new Error(`The secret for ${name} is not JSON`);
  }
  const { username, password } = (value ?? {}) as { username?: unknown; password?: unknown };
  if (username !== name) throw new Error(`The secret for ${name} belongs to another user`);
  return typeof password === "string" ? password : undefined;
}

export async function onBootstrapEvent(
  event: BootstrapEvent,
  deps: BootstrapDeps,
): Promise<{ PhysicalResourceId: string }> {
  if (event.RequestType === "Delete") {
    // The cluster is retained, and so are its roles and databases.
    console.log("Delete: leaving the roles and databases in place");
    return { PhysicalResourceId: PHYSICAL_ID };
  }
  const properties = event.ResourceProperties as unknown as BootstrapProperties;
  const names = properties.Databases.map((database) => database.Name);
  const passwords: Record<string, string | undefined> = {};
  for (const database of properties.Databases)
    passwords[database.Name] = await readPassword(deps, database.Name, database.SecretArn);
  const plan = bootstrapStatements(names, passwords);
  const secrets = Object.values(passwords).filter((password): password is string => password !== undefined);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  await runBootstrap(plan, async (sql, label) => {
    const deadline = now() + RESUME_TIMEOUT_MS;
    for (;;) {
      try {
        const output = await deps.rds.send(
          new ExecuteStatementCommand({
            resourceArn: properties.ClusterArn,
            secretArn: properties.MasterSecretArn,
            database: "postgres",
            sql,
            formatRecordsAs: "JSON",
          }),
        );
        return output.formattedRecords === undefined ? [] : (JSON.parse(output.formattedRecords) as unknown[]);
      } catch (error) {
        if (error instanceof DatabaseResumingException && now() < deadline) {
          await sleep(2_000);
          continue;
        }
        // The database's message may quote the statement, so passwords are masked.
        let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        for (const secret of secrets) message = message.replaceAll(secret, "********");
        // No `cause`: the original error may quote the statement, and with it a password.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Database bootstrap: the ${label} step failed (${message})`);
      }
    }
  });
  console.log(`${event.RequestType}: bootstrapped ${names.join(", ")}`);
  return { PhysicalResourceId: PHYSICAL_ID };
}

export function handler(event: BootstrapEvent): Promise<{ PhysicalResourceId: string }> {
  return onBootstrapEvent(event, { rds: new RDSDataClient({}), secrets: new SecretsManagerClient({}) });
}
