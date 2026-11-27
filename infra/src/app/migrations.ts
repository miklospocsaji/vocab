import { CustomResource, Duration } from "aws-cdk-lib";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { nodeFunction } from "../lambda.ts";
import type { DatabaseAccess } from "./database.ts";

// The migrations (ADR 0006): a custom resource whose properties carry the synthesised
// commit, so it runs on every deploy. For `test` it rebuilds the `app` schema first.

export interface MigrationsProps {
  readonly database: DatabaseAccess;
  readonly databaseName: string;
  readonly reset: boolean;
  readonly commit: string;
}

export class Migrations extends Construct {
  constructor(scope: Construct, id: string, props: MigrationsProps) {
    super(scope, id);
    const reset = String(props.reset);
    const fn = nodeFunction(this, "Function", {
      entry: "app/api/src/handlers/migrate.ts",
      description: `Migrations: applies app/api's migrations to ${props.databaseName}`,
      environment: { ...props.database.environment, RESET_DATABASE: reset },
      timeout: Duration.minutes(5),
    });
    props.database.grant(fn);
    const provider = new Provider(this, "Provider", { onEventHandler: fn });
    new CustomResource(this, "Resource", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::Migrations",
      properties: { Commit: props.commit, ResetDatabase: reset },
    });
  }
}
