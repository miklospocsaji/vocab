import { describe, expect, it } from "vitest";
import { dataApiConfigFromEnv } from "../src/db/data-api.ts";

describe("dataApiConfigFromEnv", () => {
  it("Scenario: The database is configured from the function's environment", () => {
    expect(
      dataApiConfigFromEnv({ CLUSTER_ARN: "arn:cluster", DATABASE_SECRET_ARN: "arn:secret", DATABASE_NAME: "vocab_test" }),
    ).toEqual({ resourceArn: "arn:cluster", secretArn: "arn:secret", database: "vocab_test" });
  });

  it("Scenario: A missing variable is named", () => {
    expect(() => dataApiConfigFromEnv({ CLUSTER_ARN: "arn:cluster", DATABASE_NAME: "vocab_test" })).toThrow(
      /DATABASE_SECRET_ARN/,
    );
  });
});
