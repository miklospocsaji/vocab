import { RemovalPolicy } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  CachePolicy,
  Distribution,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { AaaaRecord, ARecord, RecordTarget, type IHostedZone } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

// The web app: a private bucket behind CloudFront with origin access control, holding the
// `app/web` build, with the environment's domain.

export interface WebProps {
  readonly domainName: string;
  /** The us-east-1 certificate, committed in config.ts. */
  readonly certificateArn: string;
  readonly zone: IHostedZone;
  /** The built web app (`app/web/dist`). */
  readonly webDist: string;
  /** Keep the bucket when the stack goes (prod); otherwise it is emptied and destroyed. */
  readonly retain: boolean;
}

export class Web extends Construct {
  readonly url: string;

  constructor(scope: Construct, id: string, props: WebProps) {
    super(scope, id);
    const bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !props.retain,
    });

    // A single-page app: unknown paths serve index.html, and the router takes over.
    const spaFallback = (httpStatus: number) => ({ httpStatus, responseHttpStatus: 200, responsePagePath: "/index.html" });
    const distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      domainNames: [props.domainName],
      certificate: Certificate.fromCertificateArn(this, "Certificate", props.certificateArn),
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: PriceClass.PRICE_CLASS_100,
      errorResponses: [spaFallback(403), spaFallback(404)],
    });

    new BucketDeployment(this, "Deployment", {
      sources: [Source.asset(props.webDist)],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
    });

    const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
    new ARecord(this, "AliasA", { zone: props.zone, recordName: props.domainName, target });
    new AaaaRecord(this, "AliasAaaa", { zone: props.zone, recordName: props.domainName, target });

    this.url = `https://${props.domainName}`;
  }
}
