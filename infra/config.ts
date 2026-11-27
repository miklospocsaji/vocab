// The infrastructure's committed configuration (ADR 0006): plain data, imported by
// `bin/app.ts` and the scripts. The stacks take it as props, so the infra tests pass their
// own values and never read `base`.

export const account = "100159507559";
export const region = "eu-central-1";
export const certificateRegion = "us-east-1";
export const zoneName = "vocab.logtion.app";

export const environments = {
  test: { web: "test.vocab.logtion.app", api: "api.test.vocab.logtion.app", database: "vocab_test", resetDatabase: true },
  prod: { web: "vocab.logtion.app", api: "api.vocab.logtion.app", database: "vocab_prod", resetDatabase: false },
} as const;

export type EnvironmentName = keyof typeof environments;
export type Environment = (typeof environments)[EnvironmentName];

// Filled in by the owner after the base stacks are first deployed (tasks 7.2 and 7.3).
export const base = {
  hostedZoneId: "Z06520432FJKU0NDH0J3Z",
  cloudFrontCertificateArn: "",
};

export type BaseIds = typeof base;
