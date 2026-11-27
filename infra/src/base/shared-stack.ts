import { CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Provider } from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { nodeFunction } from "../lambda.ts";
import { parameters } from "../parameters.ts";

// VocabShared (base, eu-central-1, owner only): the API certificate, the VPC, the Aurora
// cluster holding both environments' databases, their secrets and roles (ADR 0007).

export interface SharedStackProps extends StackProps {
  readonly zoneName: string;
  /** The API domains, the first being the certificate's main name. */
  readonly apiDomainNames: readonly [string, ...string[]];
  /** Each environment's database, also the name of its role. */
  readonly databases: Readonly<Record<string, string>>;
}

export class SharedStack extends Stack {
  /**
   * The two zones the VPC uses. Fixed here, since CDK otherwise looks the account's zones
   * up at synth (it checks the VPC's zones against them).
   */
  override get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(scope: Construct, id: string, props: SharedStackProps) {
    super(scope, id, { terminationProtection: true, ...props });

    const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: StringParameter.valueForStringParameter(this, parameters.hostedZoneId),
      zoneName: props.zoneName,
    });
    const [domainName, ...subjectAlternativeNames] = props.apiDomainNames;
    const apiCertificate = new Certificate(this, "ApiCertificate", {
      domainName,
      subjectAlternativeNames,
      validation: CertificateValidation.fromDns(zone),
    });
    apiCertificate.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // Isolated subnets only: no NAT and no internet gateway. Only the cluster lives here;
    // Lambdas reach it through the Data API.
    const vpc = new Vpc(this, "Vpc", {
      availabilityZones: this.availabilityZones,
      natGateways: 0,
      subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });

    // Checked when built (design.md): VER_17_9 is the newest 17.x in aws-cdk-lib 2.275.0,
    // and AWS lists the Data API and a 0 ACU minimum for Aurora PostgreSQL 17.4 and higher.
    const cluster = new DatabaseCluster(this, "Cluster", {
      engine: DatabaseClusterEngine.auroraPostgres({ version: AuroraPostgresEngineVersion.VER_17_9 }),
      credentials: Credentials.fromGeneratedSecret("vocab_admin"),
      writer: ClusterInstance.serverlessV2("Writer"),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      serverlessV2AutoPauseDuration: Duration.minutes(10),
      enableDataApi: true,
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      storageEncrypted: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      backup: { retention: Duration.days(7) },
    });
    const masterSecret = cluster.secret;
    if (masterSecret === undefined) throw new Error("The cluster has no master secret");

    // One user per environment, in the shape the Data API expects. `excludePunctuation`
    // keeps each password to letters and digits, which the bootstrap checks.
    const users = Object.entries(props.databases).map(([environment, database]) => {
      const secret = new Secret(this, `${capitalise(environment)}DatabaseSecret`, {
        description: `The ${database} database user`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: database }),
          generateStringKey: "password",
          excludePunctuation: true,
          passwordLength: 32,
        },
        removalPolicy: RemovalPolicy.RETAIN,
      });
      new StringParameter(this, `${capitalise(environment)}DatabaseSecretArnParameter`, {
        parameterName: parameters.databaseSecretArn(environment),
        stringValue: secret.secretArn,
      });
      return { database, secret };
    });

    // The bootstrap: the only function that may read the master secret.
    const bootstrap = nodeFunction(this, "DatabaseBootstrapFunction", {
      entry: "infra/src/base/db-bootstrap/handler.ts",
      description: "Database bootstrap: one role and one database per environment",
      timeout: Duration.minutes(5),
    });
    cluster.grantDataApiAccess(bootstrap);
    for (const user of users) user.secret.grantRead(bootstrap);
    const provider = new Provider(this, "DatabaseBootstrapProvider", { onEventHandler: bootstrap });
    const resource = new CustomResource(this, "DatabaseBootstrap", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::DatabaseBootstrap",
      properties: {
        ClusterArn: cluster.clusterArn,
        MasterSecretArn: masterSecret.secretArn,
        Databases: users.map((user) => ({ Name: user.database, SecretArn: user.secret.secretArn })),
      },
    });
    resource.node.addDependency(cluster);

    new StringParameter(this, "ApiCertificateArnParameter", {
      parameterName: parameters.apiCertificateArn,
      stringValue: apiCertificate.certificateArn,
    });
    new StringParameter(this, "ClusterArnParameter", {
      parameterName: parameters.clusterArn,
      stringValue: cluster.clusterArn,
    });
  }
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
