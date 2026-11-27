import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { Environment, EnvironmentName } from "../config.ts";
import { Api } from "./app/api.ts";
import { databaseAccess } from "./app/database.ts";
import { Migrations } from "./app/migrations.ts";
import { Web } from "./app/web.ts";
import { parameters } from "./parameters.ts";

// VocabApp-<env> (ADR 0006): the one app stack, deployed once per environment from the same
// code. What features change lives here and in ./app/.

export interface AppStackProps extends StackProps {
  readonly environmentName: EnvironmentName;
  readonly environment: Environment;
  readonly zoneName: string;
  /** The CloudFront certificate in us-east-1, committed in config.ts. */
  readonly cloudFrontCertificateArn: string;
  /** The commit synthesised, for the health check, the migrations and the `Commit` output. */
  readonly commit: string;
  /** The built web app (`app/web/dist`). */
  readonly webDist: string;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    const prod = props.environmentName === "prod";
    super(scope, id, { terminationProtection: prod, ...props });
    const { environment } = props;

    const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: StringParameter.valueForStringParameter(this, parameters.hostedZoneId),
      zoneName: props.zoneName,
    });
    const database = databaseAccess(this, props.environmentName, environment.database);

    const web = new Web(this, "Web", {
      domainName: environment.web,
      certificateArn: props.cloudFrontCertificateArn,
      zone,
      webDist: props.webDist,
      retain: prod,
    });
    const api = new Api(this, "Api", {
      domainName: environment.api,
      webOrigin: web.url,
      zone,
      database,
      commit: props.commit,
    });
    new Migrations(this, "Migrations", {
      database,
      databaseName: environment.database,
      reset: environment.resetDatabase,
      commit: props.commit,
    });

    // Fixed ids: the deploy writes them to its outputs file.
    new CfnOutput(this, "WebUrl", { value: web.url }).overrideLogicalId("WebUrl");
    new CfnOutput(this, "ApiUrl", { value: api.url }).overrideLogicalId("ApiUrl");
    new CfnOutput(this, "Commit", { value: props.commit }).overrideLogicalId("Commit");
  }
}
