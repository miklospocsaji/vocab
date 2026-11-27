import type { App, Stack } from "aws-cdk-lib";
import {
  account,
  certificateRegion,
  environments,
  region,
  zoneName,
  type BaseIds,
  type EnvironmentName,
} from "../config.ts";
import { AppStack } from "./app-stack.ts";
import { CertificateStack } from "./base/certificate-stack.ts";
import { SharedStack } from "./base/shared-stack.ts";
import { ZoneStack } from "./base/zone-stack.ts";

// Which stacks each environment synthesises (ADR 0006): `base` is the owner's base stacks,
// `test` and `prod` their app stack. Empty `config.base` ids are handled here, never by a
// placeholder.

export const environmentNames = ["base", "test", "prod"] as const;
export type SynthEnvironment = (typeof environmentNames)[number];

export function isAppEnvironment(name: string): name is EnvironmentName {
  return Object.hasOwn(environments, name);
}

/**
 * Throws unless `name` is an environment that can be synthesised with `base`: `test` and
 * `prod` need the CloudFront certificate's ARN. Synth calls it before the web build.
 */
export function checkEnvironment(name: string, base: BaseIds): asserts name is SynthEnvironment {
  if (!(environmentNames as readonly string[]).includes(name))
    throw new Error(`Unknown environment "${name}": expected ${environmentNames.join(", ")}`);
  if (name !== "base" && base.cloudFrontCertificateArn === "")
    throw new Error("config.base.cloudFrontCertificateArn is empty: deploy the base stacks first");
}

export interface BuildOptions {
  readonly base: BaseIds;
  readonly commit: string;
  /** The built web app, for `test` and `prod`. */
  readonly webDist: string;
  /** Where to print notes, such as a stack left out. */
  readonly note: (message: string) => void;
}

export function buildStacks(app: App, name: string, options: BuildOptions): Stack[] {
  checkEnvironment(name, options.base);
  const env = { account, region };
  if (name === "base") {
    const stacks: Stack[] = [new ZoneStack(app, "VocabZone", { env, zoneName })];
    if (options.base.hostedZoneId === "") {
      options.note("VocabCertificates is left out: config.base.hostedZoneId is empty (task 7.2 commits it)");
    } else {
      stacks.push(
        new CertificateStack(app, "VocabCertificates", {
          env: { account, region: certificateRegion },
          zoneName,
          hostedZoneId: options.base.hostedZoneId,
          domainNames: [environments.prod.web, environments.test.web],
        }),
      );
    }
    stacks.push(
      new SharedStack(app, "VocabShared", {
        env,
        zoneName,
        apiDomainNames: [environments.prod.api, environments.test.api],
        databases: { test: environments.test.database, prod: environments.prod.database },
      }),
    );
    return stacks;
  }
  return [
    new AppStack(app, `VocabApp-${name}`, {
      env,
      environmentName: name,
      environment: environments[name],
      zoneName,
      cloudFrontCertificateArn: options.base.cloudFrontCertificateArn,
      commit: options.commit,
      webDist: options.webDist,
    }),
  ];
}
