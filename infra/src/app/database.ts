import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { parameters } from "../parameters.ts";

// An environment's access to its database (ADR 0007): the cluster and the environment's own
// secret, both read from VocabShared's SSM parameters at deploy time. Nothing here can name
// the master secret or another environment's.

export interface DatabaseAccess {
  /** The variables `dataApiConfigFromEnv` reads. */
  readonly environment: Record<string, string>;
  /** Lets `fn` run Data API statements on the cluster as the environment's user. */
  grant(fn: IFunction): void;
}

export function databaseAccess(scope: Construct, environmentName: string, database: string): DatabaseAccess {
  const clusterArn = StringParameter.valueForStringParameter(scope, parameters.clusterArn);
  const secretArn = StringParameter.valueForStringParameter(scope, parameters.databaseSecretArn(environmentName));
  return {
    environment: { CLUSTER_ARN: clusterArn, DATABASE_SECRET_ARN: secretArn, DATABASE_NAME: database },
    grant(fn) {
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: [
            "rds-data:ExecuteStatement",
            "rds-data:BatchExecuteStatement",
            "rds-data:BeginTransaction",
            "rds-data:CommitTransaction",
            "rds-data:RollbackTransaction",
          ],
          resources: [clusterArn],
        }),
      );
      fn.addToRolePolicy(new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [secretArn] }));
    },
  };
}
