import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";

// Shared by the infra tests. Stacks are synthesised without esbuild bundling, and with
// fixed dummy ids, never config.base.

export const account = "111111111111";
export const region = "eu-central-1";
export const zoneName = "vocab.logtion.app";
export const dummyIds = {
  hostedZoneId: "Z0000000000000000000",
  cloudFrontCertificateArn: "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000",
};

export function newApp(): App {
  return new App({ context: { "aws:cdk:bundling-stacks": [] } });
}

/** A stand-in for `app/web/dist`, so the tests need no web build. */
export function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "vocab-web-dist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>test</title>");
  return dir;
}

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

/** Every resource of `type`, by logical id. */
export function resourcesOf(template: Template, type: string): Resources {
  return template.findResources(type) as Resources;
}

/** True when `value`, anywhere inside, mentions `needle` (a logical id or a name). */
export function mentions(value: unknown, needle: string): boolean {
  return (JSON.stringify(value) as string | undefined ?? "").includes(needle);
}

/** The IAM policies whose statements allow `action`, with the roles they attach to. */
export function policiesAllowing(template: Template, action: string): { roles: unknown; statements: unknown[] }[] {
  return Object.values(resourcesOf(template, "AWS::IAM::Policy"))
    .map((policy) => {
      const properties = policy.Properties as { PolicyDocument: { Statement: { Action: unknown }[] }; Roles: unknown };
      const statements = properties.PolicyDocument.Statement.filter((statement) =>
        ([] as unknown[]).concat(statement.Action).includes(action),
      );
      return { roles: properties.Roles, statements };
    })
    .filter((policy) => policy.statements.length > 0);
}
