import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CertificateStack } from "../src/base/certificate-stack.ts";
import { SharedStack } from "../src/base/shared-stack.ts";
import { ZoneStack } from "../src/base/zone-stack.ts";
import { account, dummyIds, mentions, newApp, policiesAllowing, region, resourcesOf, zoneName } from "./helpers.ts";

function synthBase() {
  const app = newApp();
  const zone = new ZoneStack(app, "VocabZone", { env: { account, region }, zoneName });
  const certificates = new CertificateStack(app, "VocabCertificates", {
    env: { account, region: "us-east-1" },
    zoneName,
    hostedZoneId: dummyIds.hostedZoneId,
    domainNames: ["vocab.logtion.app", "test.vocab.logtion.app"],
  });
  const shared = new SharedStack(app, "VocabShared", {
    env: { account, region },
    zoneName,
    apiDomainNames: ["api.vocab.logtion.app", "api.test.vocab.logtion.app"],
    databases: { test: "vocab_test", prod: "vocab_prod" },
  });
  const assembly = app.synth();
  return {
    assembly,
    zone: Template.fromStack(zone),
    certificates: Template.fromStack(certificates),
    shared: Template.fromStack(shared),
    certificatesRegion: certificates.region,
  };
}

const base = synthBase();

describe("VocabZone", () => {
  it("Scenario: The zone is a public hosted zone for vocab.logtion.app", () => {
    base.zone.resourceCountIs("AWS::Route53::HostedZone", 1);
    base.zone.hasResourceProperties("AWS::Route53::HostedZone", { Name: "vocab.logtion.app." });
  });

  it("Scenario: The zone outputs its id and name servers", () => {
    const outputs = base.zone.findOutputs("*");
    expect(Object.keys(outputs).sort()).toEqual(["HostedZoneId", "NameServers"]);
  });

  it("Scenario: The zone writes its id to SSM", () => {
    base.zone.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/vocab/base/hosted-zone-id",
      Type: "String",
      Value: { Ref: Match.anyValue() },
    });
  });
});

describe("VocabCertificates", () => {
  it("Scenario: The CloudFront certificate is in us-east-1 with both names", () => {
    expect(base.certificatesRegion).toBe("us-east-1");
    base.certificates.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "vocab.logtion.app",
      SubjectAlternativeNames: ["test.vocab.logtion.app"],
      ValidationMethod: "DNS",
      DomainValidationOptions: Match.arrayWith([
        { DomainName: "vocab.logtion.app", HostedZoneId: dummyIds.hostedZoneId },
        { DomainName: "test.vocab.logtion.app", HostedZoneId: dummyIds.hostedZoneId },
      ]),
    });
    expect(Object.keys(base.certificates.findOutputs("*"))).toEqual(["CertificateArn"]);
  });
});

describe("VocabShared", () => {
  const { shared } = base;

  it("Scenario: The API certificate has both names, validated in the zone from SSM", () => {
    shared.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "api.vocab.logtion.app",
      SubjectAlternativeNames: ["api.test.vocab.logtion.app"],
      ValidationMethod: "DNS",
    });
    const [certificate] = Object.values(resourcesOf(shared, "AWS::CertificateManager::Certificate"));
    const parameters = shared.toJSON() as { Parameters: Record<string, { Default?: string }> };
    const zoneParameter = Object.entries(parameters.Parameters).find(
      ([, parameter]) => parameter.Default === "/vocab/base/hosted-zone-id",
    );
    expect(zoneParameter).toBeDefined();
    expect(mentions(certificate?.Properties?.["DomainValidationOptions"], zoneParameter?.[0] ?? "?")).toBe(true);
  });

  it("Scenario: The VPC has isolated subnets only and no NAT gateway", () => {
    shared.resourceCountIs("AWS::EC2::VPC", 1);
    shared.resourceCountIs("AWS::EC2::NatGateway", 0);
    shared.resourceCountIs("AWS::EC2::InternetGateway", 0);
    shared.resourceCountIs("AWS::EC2::Route", 0);
    const subnets = Object.values(resourcesOf(shared, "AWS::EC2::Subnet"));
    expect(subnets).toHaveLength(2);
    for (const subnet of subnets) expect(subnet.Properties?.["MapPublicIpOnLaunch"]).toBe(false);
  });

  it("Scenario: The cluster is Aurora Serverless v2 PostgreSQL 17 with the Data API", () => {
    shared.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      EngineVersion: "17.9",
      EnableHttpEndpoint: true,
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 2, SecondsUntilAutoPause: 600 },
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
      StorageEncrypted: true,
    });
    shared.hasResource("AWS::RDS::DBCluster", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    shared.resourceCountIs("AWS::RDS::DBInstance", 1);
    shared.hasResourceProperties("AWS::RDS::DBInstance", { DBInstanceClass: "db.serverless" });
  });

  it("Scenario: There are three secrets, the environment ones in the Data API's shape", () => {
    shared.resourceCountIs("AWS::SecretsManager::Secret", 3);
    for (const user of ["vocab_test", "vocab_prod"]) {
      shared.hasResourceProperties("AWS::SecretsManager::Secret", {
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: user }),
          GenerateStringKey: "password",
          ExcludePunctuation: true,
          PasswordLength: 32,
        },
      });
    }
  });

  it("Scenario: The bootstrap custom resource carries secret ARNs, never secret values", () => {
    shared.resourceCountIs("Custom::DatabaseBootstrap", 1);
    const [bootstrap] = Object.values(resourcesOf(shared, "Custom::DatabaseBootstrap"));
    const properties = bootstrap?.Properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(["ClusterArn", "Databases", "MasterSecretArn", "ServiceToken"]);
    expect(mentions(properties, "resolve:secretsmanager")).toBe(false);
    expect(mentions(properties, "vocab_test")).toBe(true);
    expect(mentions(properties, "vocab_prod")).toBe(true);
  });

  /** The logical ids through which a policy can name each secret (a secret, or its attachment). */
  function secretRefs(): { master: string[]; environments: string[] } {
    const secrets = resourcesOf(shared, "AWS::SecretsManager::Secret");
    const isEnvironment = (id: string) =>
      (secrets[id]?.Properties?.["GenerateSecretString"] as { ExcludePunctuation?: boolean } | undefined)
        ?.ExcludePunctuation === true;
    const masterId = Object.keys(secrets).find((id) => !isEnvironment(id)) ?? "?";
    const attachments = Object.entries(resourcesOf(shared, "AWS::SecretsManager::SecretTargetAttachment"))
      .filter(([, attachment]) => mentions(attachment.Properties?.["SecretId"], masterId))
      .map(([id]) => id);
    return { master: [masterId, ...attachments], environments: Object.keys(secrets).filter(isEnvironment) };
  }

  function bootstrapRole(): string {
    const functions = Object.values(resourcesOf(shared, "AWS::Lambda::Function")).filter((fn) =>
      mentions(fn.Properties?.["Description"], "Database bootstrap"),
    );
    expect(functions).toHaveLength(1);
    const role = functions[0]?.Properties?.["Role"] as { "Fn::GetAtt": [string, string] };
    return role["Fn::GetAtt"][0];
  }

  it("Scenario: Only the bootstrap function may read the master secret", () => {
    const { master, environments } = secretRefs();
    expect(master.length).toBeGreaterThan(1);
    expect(environments).toHaveLength(2);
    const readers = policiesAllowing(shared, "secretsmanager:GetSecretValue").filter((policy) =>
      policy.statements.some((statement) => master.some((id) => mentions(statement, `"${id}"`))),
    );
    expect(readers.map((policy) => policy.roles)).toEqual([[{ Ref: bootstrapRole() }]]);
  });

  it("Scenario: The bootstrap function runs on Node 24 arm64 and may read both environment secrets", () => {
    const [fn] = Object.values(resourcesOf(shared, "AWS::Lambda::Function")).filter((f) =>
      mentions(f.Properties?.["Description"], "Database bootstrap"),
    );
    expect(fn?.Properties?.["Runtime"]).toBe("nodejs24.x");
    expect(fn?.Properties?.["Architectures"]).toEqual(["arm64"]);
    const statements = policiesAllowing(shared, "secretsmanager:GetSecretValue")
      .filter((policy) => mentions(policy.roles, bootstrapRole()))
      .flatMap((policy) => policy.statements);
    for (const id of secretRefs().environments) expect(statements.some((statement) => mentions(statement, `"${id}"`))).toBe(true);
  });

  it("Scenario: The shared stack writes the four SSM parameters", () => {
    const names = Object.values(resourcesOf(shared, "AWS::SSM::Parameter"))
      .map((parameter) => parameter.Properties?.["Name"])
      .sort();
    expect(names).toEqual([
      "/vocab/base/api-certificate-arn",
      "/vocab/base/cluster-arn",
      "/vocab/base/prod/database-secret-arn",
      "/vocab/base/test/database-secret-arn",
    ]);
  });

  it("Scenario: No base stack reports missing context", () => {
    expect(base.assembly.manifest.missing ?? []).toEqual([]);
  });
});
