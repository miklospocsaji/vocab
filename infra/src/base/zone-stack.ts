import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { PublicHostedZone } from "aws-cdk-lib/aws-route53";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { parameters } from "../parameters.ts";

// VocabZone (base, eu-central-1, owner only): the hosted zone that `logtion.app` delegates
// `vocab.logtion.app` to. A stack of its own, since the delegation must be in place before
// any certificate can validate.

export interface ZoneStackProps extends StackProps {
  readonly zoneName: string;
}

export class ZoneStack extends Stack {
  constructor(scope: Construct, id: string, props: ZoneStackProps) {
    super(scope, id, { terminationProtection: true, ...props });
    const zone = new PublicHostedZone(this, "Zone", { zoneName: props.zoneName });
    zone.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // For VocabShared and the app stacks; VocabCertificates (us-east-1) has it committed.
    new StringParameter(this, "HostedZoneIdParameter", {
      parameterName: parameters.hostedZoneId,
      stringValue: zone.hostedZoneId,
    });

    new CfnOutput(this, "HostedZoneId", { value: zone.hostedZoneId });
    new CfnOutput(this, "NameServers", { value: Fn.join(",", zone.hostedZoneNameServers ?? []) });
  }
}
