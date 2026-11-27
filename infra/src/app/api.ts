import { Duration } from "aws-cdk-lib";
import { CorsHttpMethod, DomainName, HttpApi, HttpMethod, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { AaaaRecord, ARecord, RecordTarget, type IHostedZone } from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { nodeFunction } from "../lambda.ts";
import { parameters } from "../parameters.ts";
import type { DatabaseAccess } from "./database.ts";

// The API: an HTTP API on the environment's domain, with `GET /health`.

export interface ApiProps {
  readonly domainName: string;
  /** The only origin CORS allows, such as `https://test.vocab.logtion.app`. */
  readonly webOrigin: string;
  readonly zone: IHostedZone;
  readonly database: DatabaseAccess;
  readonly commit: string;
}

export class Api extends Construct {
  readonly url: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const certificateArn = StringParameter.valueForStringParameter(this, parameters.apiCertificateArn);
    const domain = new DomainName(this, "Domain", {
      domainName: props.domainName,
      certificate: Certificate.fromCertificateArn(this, "Certificate", certificateArn),
    });

    const api = new HttpApi(this, "HttpApi", {
      description: `Kindle Vocab API (${props.domainName})`,
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [props.webOrigin],
        allowMethods: [CorsHttpMethod.ANY],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    // The default stage, created by hand for its throttling: a cost guard.
    new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
      domainMapping: { domainName: domain },
    });

    const health = nodeFunction(this, "HealthFunction", {
      entry: "app/api/src/handlers/health.ts",
      description: "GET /health: answers whether the API reaches its database",
      environment: { ...props.database.environment, COMMIT: props.commit },
    });
    props.database.grant(health);
    api.addRoutes({ path: "/health", methods: [HttpMethod.GET], integration: new HttpLambdaIntegration("Health", health) });

    const target = RecordTarget.fromAlias(
      new ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId),
    );
    new ARecord(this, "AliasA", { zone: props.zone, recordName: props.domainName, target });
    new AaaaRecord(this, "AliasAaaa", { zone: props.zone, recordName: props.domainName, target });

    this.url = `https://${props.domainName}`;
  }
}
