import { describe, expect, it } from "vitest";
import { buildStacks, checkEnvironment } from "../src/stacks.ts";
import { dummyIds, fakeWebDist, newApp } from "./helpers.ts";

const empty = { hostedZoneId: "", cloudFrontCertificateArn: "" };
const webDist = fakeWebDist();

function build(env: string, base: typeof empty) {
  const notes: string[] = [];
  const stacks = buildStacks(newApp(), env, { base, commit: "abc", webDist, note: (message) => notes.push(message) });
  return { names: stacks.map((stack) => stack.stackName), regions: stacks.map((stack) => stack.region), notes };
}

describe("buildStacks", () => {
  it("Scenario: Base without the zone id has VocabZone and VocabShared, with a note", () => {
    const { names, notes } = build("base", empty);
    expect(names).toEqual(["VocabZone", "VocabShared"]);
    expect(notes).toEqual([expect.stringMatching(/VocabCertificates.*hostedZoneId/)]);
  });

  it("Scenario: Base with the zone id has all three base stacks, the certificates in us-east-1", () => {
    const { names, regions, notes } = build("base", { ...empty, hostedZoneId: dummyIds.hostedZoneId });
    expect(names).toEqual(["VocabZone", "VocabCertificates", "VocabShared"]);
    expect(regions).toEqual(["eu-central-1", "us-east-1", "eu-central-1"]);
    expect(notes).toEqual([]);
  });

  it.each(["test", "prod"])("Scenario: %s has only its app stack", (env) => {
    expect(build(env, dummyIds).names).toEqual([`VocabApp-${env}`]);
  });

  it.each(["test", "prod"])("Scenario: %s fails at once without the CloudFront certificate ARN", (env) => {
    expect(() => build(env, { ...dummyIds, cloudFrontCertificateArn: "" })).toThrow(
      "config.base.cloudFrontCertificateArn is empty: deploy the base stacks first",
    );
    expect(() => {
      checkEnvironment(env, { ...dummyIds, cloudFrontCertificateArn: "" });
    }).toThrow(
      "config.base.cloudFrontCertificateArn is empty: deploy the base stacks first",
    );
  });

  it("Scenario: An unknown environment is refused", () => {
    expect(() => build("stage", dummyIds)).toThrow(/Unknown environment "stage"/);
    expect(() => {
      checkEnvironment("stage", dummyIds);
    }).toThrow(/Unknown environment "stage"/);
  });
});
