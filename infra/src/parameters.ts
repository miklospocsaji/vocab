// The SSM parameters (eu-central-1) through which the base stacks hand values to the stacks
// that use them. CloudFormation resolves them at deploy time, so synth never looks them up.

export const parameters = {
  hostedZoneId: "/vocab/base/hosted-zone-id",
  apiCertificateArn: "/vocab/base/api-certificate-arn",
  clusterArn: "/vocab/base/cluster-arn",
  databaseSecretArn: (environment: string): string => `/vocab/base/${environment}/database-secret-arn`,
} as const;
