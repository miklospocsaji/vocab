import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";

// VocabCertificates (base, us-east-1, owner only): the CloudFront certificate, which
// CloudFront accepts only from us-east-1. It cannot read eu-central-1's SSM parameters, so
// the zone's id is committed in config.ts.

export interface CertificateStackProps extends StackProps {
  readonly zoneName: string;
  readonly hostedZoneId: string;
  /** The web domains, the first being the certificate's main name. */
  readonly domainNames: readonly [string, ...string[]];
}

export class CertificateStack extends Stack {
  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, { terminationProtection: true, ...props });
    const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.zoneName,
    });
    const [domainName, ...subjectAlternativeNames] = props.domainNames;
    const certificate = new Certificate(this, "Certificate", {
      domainName,
      subjectAlternativeNames,
      validation: CertificateValidation.fromDns(zone),
    });
    certificate.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, "CertificateArn", { value: certificate.certificateArn });
  }
}
