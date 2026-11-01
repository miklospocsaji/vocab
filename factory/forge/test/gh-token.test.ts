import { describe, expect, it } from "vitest";
import { ghAuthToken, type RunCommand } from "../src/index.ts";

const TOKEN = "gho_fakeTokenForTests0123456789abcdefXYZ";

describe("ghAuthToken", () => {
  it("runs `gh auth token` and returns the token without its newline", async () => {
    const calls: [string, string[]][] = [];
    const run: RunCommand = (command, args) => {
      calls.push([command, args]);
      return Promise.resolve(`${TOKEN}\n`);
    };

    expect(await ghAuthToken(run)).toBe(TOKEN);
    expect(calls).toEqual([["gh", ["auth", "token"]]]);
  });

  it("rejects with login instructions when gh fails", async () => {
    const run: RunCommand = () => Promise.reject(new Error("no oauth token found for github.com"));

    await expect(ghAuthToken(run)).rejects.toThrow(/gh auth login/);
  });

  it("rejects with login instructions when gh prints no token", async () => {
    const run: RunCommand = () => Promise.resolve("  \n");

    await expect(ghAuthToken(run)).rejects.toThrow(/gh auth login/);
  });
});
