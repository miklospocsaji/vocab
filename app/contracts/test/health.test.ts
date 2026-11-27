import { describe, expect, it } from "vitest";
import { HealthResponse } from "../src/index.ts";

describe("HealthResponse", () => {
  it("Scenario: Accepts the ok shape", () => {
    const body = { status: "ok", database: "ok", commit: "abc123" };
    expect(HealthResponse.parse(body)).toEqual(body);
  });

  it("Scenario: Accepts the unavailable shape", () => {
    const body = { status: "ok", database: "unavailable", commit: "abc123" };
    expect(HealthResponse.parse(body)).toEqual(body);
  });

  it("Scenario: Rejects an unknown field", () => {
    const body = { status: "ok", database: "ok", commit: "abc123", extra: true };
    expect(HealthResponse.safeParse(body).success).toBe(false);
  });

  it("Scenario: Rejects an unknown database value", () => {
    const body = { status: "ok", database: "degraded", commit: "abc123" };
    expect(HealthResponse.safeParse(body).success).toBe(false);
  });
});
