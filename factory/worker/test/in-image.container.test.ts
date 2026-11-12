/**
 * Live checks that hold only inside the factory-worker image (add-factory-worker task 1.16):
 * real Agent SDK sessions on Haiku with throwaway probe roles, about $0.10 each at most.
 * `container.live.test.ts` runs this file in a container started with no added capabilities.
 * "Missing sandbox blocks Bash" is retired (add-build-roles task 2.14): no worker role has Bash,
 * and Bash roles run in the build container with the sandbox off (ADR 0011).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCostLog,
  makeWorktree,
  removeDir,
  runProbe,
  toolCalls,
  toolOutcome,
  writeFile,
  writeProbeRole,
} from "../../roles/test/live-harness.ts";

let worktree: string;
const costs = createCostLog();

beforeEach(() => {
  worktree = makeWorktree();
});

afterEach(() => {
  removeDir(worktree);
});

afterAll(() => {
  costs.print();
});

describe("in the factory-worker container", () => {
  it("runs the Grep tool without a system ripgrep", async () => {
    const needle = `grep-probe-${String(Date.now())}`;
    writeFile(worktree, "docs/notes.md", `# Notes\n\n${needle}\n`);
    const role = await writeProbeRole(worktree, {
      name: "probe-grep",
      tools: ["Read", "Grep"],
      allow: ["Read", "Grep"],
      writable: [],
      intro: [
        "You are a probe role in an automated test of an agent harness's search tool.",
        "You must actually make the tool call described: do not skip it, ask about it or refuse it.",
      ].join("\n"),
      task: `Use the Grep tool once, with the pattern \`${needle}\` and no path, to find which file contains it.`,
    });

    const attempt = await runProbe(role, worktree);
    costs.track("Grep without a system ripgrep", attempt);

    const calls = toolCalls(attempt.messages).filter((call) => call.name === "Grep");
    expect(calls.length, "the model never ran Grep").toBeGreaterThan(0);
    const outcome = toolOutcome(attempt.messages, calls[0]?.id ?? "");
    expect(outcome?.isError).toBe(false);
    expect(outcome?.text).toContain("notes.md");
  });
});
