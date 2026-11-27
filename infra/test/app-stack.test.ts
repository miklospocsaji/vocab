import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { environments, type EnvironmentName } from "../config.ts";
import { AppStack } from "../src/app-stack.ts";
import { account, dummyIds, fakeWebDist, mentions, newApp, policiesAllowing, region, resourcesOf, zoneName } from "./helpers.ts";

const webDist = fakeWebDist();

function synthApp(name: EnvironmentName) {
  const app = newApp();
  const stack = new AppStack(app, `VocabApp-${name}`, {
    env: { account, region },
    environmentName: name,
    environment: environments[name],
    zoneName,
    cloudFrontCertificateArn: dummyIds.cloudFrontCertificateArn,
    commit: "0123456789abcdef",
    webDist,
  });
  const assembly = app.synth();
  return { stack, assembly, template: Template.fromStack(stack) };
}

/** The logical id of the template parameter that reads `name` from SSM. */
function ssmParameterId(template: Template, name: string): string | undefined {
  const { Parameters } = template.toJSON() as { Parameters?: Record<string, { Default?: string }> };
  return Object.entries(Parameters ?? {}).find(([, parameter]) => parameter.Default === name)?.[0];
}

function functionsByDescription(template: Template, description: string) {
  return Object.entries(resourcesOf(template, "AWS::Lambda::Function")).filter(([, fn]) =>
    String(fn.Properties?.["Description"]).startsWith(description),
  );
}

/** The properties of the one function whose description starts with `prefix`. */
function onlyFunction(template: Template, prefix: string): Record<string, unknown> {
  const functions = functionsByDescription(template, prefix);
  expect(functions).toHaveLength(1);
  return functions[0]?.[1].Properties ?? {};
}

describe.each(["test", "prod"] as const)("VocabApp-%s", (name) => {
  const { stack, assembly, template } = synthApp(name);
  const config = environments[name];
  const other = name === "test" ? "prod" : "test";

  it("Scenario: The web bucket is private and served through origin access control", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: "s3", SigningBehavior: "always" }),
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject" }),
        ]),
      },
    });
  });

  it("Scenario: The distribution has the environment's alias, HTTPS only and the SPA fallback", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: [config.web],
        DefaultRootObject: "index.html",
        ViewerCertificate: {
          AcmCertificateArn: dummyIds.cloudFrontCertificateArn,
          SslSupportMethod: "sni-only",
          MinimumProtocolVersion: "TLSv1.2_2021",
        },
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "https-only" }),
        CustomErrorResponses: [
          { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" },
          { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" },
        ],
      }),
    });
  });

  it("Scenario: The web build is deployed to the bucket and invalidated", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", { DistributionPaths: ["/*"] });
  });

  it("Scenario: The HTTP API has the custom domain, CORS for the web origin only and throttling", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: Match.objectLike({ AllowOrigins: [`https://${config.web}`] }),
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", { DomainName: config.api });
    const [domain] = Object.values(resourcesOf(template, "AWS::ApiGatewayV2::DomainName"));
    const certificateParameter = ssmParameterId(template, "/vocab/base/api-certificate-arn");
    expect(certificateParameter).toBeDefined();
    expect(mentions(domain?.Properties?.["DomainNameConfigurations"], certificateParameter ?? "?")).toBe(true);
    template.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /health" });
  });

  it("Scenario: Route 53 has A and AAAA alias records for the web and the API, in the zone from SSM", () => {
    const zoneParameter = ssmParameterId(template, "/vocab/base/hosted-zone-id");
    expect(zoneParameter).toBeDefined();
    const records = Object.values(resourcesOf(template, "AWS::Route53::RecordSet")).map((record) => ({
      name: record.Properties?.["Name"],
      type: record.Properties?.["Type"],
      alias: record.Properties?.["AliasTarget"] !== undefined,
      zone: mentions(record.Properties?.["HostedZoneId"], zoneParameter ?? "?"),
    }));
    expect(records).toHaveLength(4);
    for (const domain of [config.web, config.api])
      for (const type of ["A", "AAAA"]) expect(records).toContainEqual({ name: `${domain}.`, type, alias: true, zone: true });
  });

  it("Scenario: The health and migrate functions run on Node 24 arm64", () => {
    for (const description of ["GET /health:", "Migrations:"]) {
      const functions = functionsByDescription(template, description);
      expect(functions).toHaveLength(1);
      expect(functions[0]?.[1].Properties).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"] });
    }
    const health = onlyFunction(template, "GET /health:");
    expect(health).toMatchObject({ MemorySize: 256, Timeout: 10 });
    expect(mentions(health["Environment"], `"DATABASE_NAME":"${config.database}"`)).toBe(true);
    expect(mentions(health["Environment"], '"COMMIT":"0123456789abcdef"')).toBe(true);
  });

  it("Scenario: The environment's functions may read only their own database secret", () => {
    const own = ssmParameterId(template, `/vocab/base/${name}/database-secret-arn`);
    expect(own).toBeDefined();
    expect(ssmParameterId(template, `/vocab/base/${other}/database-secret-arn`)).toBeUndefined();
    const statements = policiesAllowing(template, "secretsmanager:GetSecretValue").flatMap((policy) => policy.statements);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect((statement as { Resource: unknown }).Resource).toEqual({ Ref: own });
    }
    // The stack never names the master secret: no secret but its own reaches any policy.
    expect(mentions(template.toJSON(), "vocab_admin")).toBe(false);
    expect(mentions(template.toJSON(), other === "prod" ? "vocab_prod" : "vocab_test")).toBe(false);
  });

  it("Scenario: The functions may run Data API statements on the cluster from SSM", () => {
    const cluster = ssmParameterId(template, "/vocab/base/cluster-arn");
    const statements = policiesAllowing(template, "rds-data:ExecuteStatement").flatMap((policy) => policy.statements);
    expect(statements.length).toBeGreaterThanOrEqual(2);
    for (const statement of statements) expect((statement as { Resource: unknown }).Resource).toEqual({ Ref: cluster });
  });

  it("Scenario: The migrate custom resource carries the commit and the environment's RESET_DATABASE", () => {
    template.hasResourceProperties("Custom::Migrations", {
      Commit: "0123456789abcdef",
      ResetDatabase: String(config.resetDatabase),
    });
    const migrate = onlyFunction(template, "Migrations:");
    expect(mentions(migrate["Environment"], `"RESET_DATABASE":"${String(config.resetDatabase)}"`)).toBe(true);
  });

  it("Scenario: The stack outputs WebUrl, ApiUrl and Commit", () => {
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs).sort()).toEqual(["ApiUrl", "Commit", "WebUrl"]);
    expect(outputs["WebUrl"]?.["Value"]).toBe(`https://${config.web}`);
    expect(outputs["ApiUrl"]?.["Value"]).toBe(`https://${config.api}`);
    expect(outputs["Commit"]?.["Value"]).toBe("0123456789abcdef");
  });

  it(`Scenario: ${name === "prod" ? "Prod has termination protection and retains its bucket" : "Test destroys its bucket with the stack"}`, () => {
    const [bucket] = Object.values(template.findResources("AWS::S3::Bucket")) as { DeletionPolicy?: string }[];
    if (name === "prod") {
      expect(stack.terminationProtection).toBe(true);
      expect(bucket?.DeletionPolicy).toBe("Retain");
      template.resourceCountIs("Custom::S3AutoDeleteObjects", 0);
    } else {
      expect(stack.terminationProtection).toBe(false);
      expect(bucket?.DeletionPolicy).toBe("Delete");
      template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
    }
  });

  it("Scenario: No app stack reports missing context", () => {
    expect(assembly.manifest.missing ?? []).toEqual([]);
  });
});
