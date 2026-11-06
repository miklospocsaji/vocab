/**
 * Live checks that hold only inside the factory-worker image (add-factory-worker task 1.16):
 * real Agent SDK sessions on Haiku with throwaway probe roles, about $0.10 each at most.
 * `container.live.test.ts` runs this file in a container started with no added capabilities;
 * on the host the sandbox starts, so these would not hold there.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHANGE,
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
  it("Scenario: Missing sandbox blocks Bash", async () => {
    // Allowlisted and inside the writable paths: only the missing sandbox stops it.
    const marker = `${CHANGE}/marker.txt`;
    const role = await writeProbeRole(worktree, {
      name: "probe-missing-sandbox",
      tools: ["Read", "Bash"],
      allow: ["Read", "Bash(touch:*)"],
      writable: ["openspec/changes/{changeId}/marker.txt"],
      intro: [
        "You are a probe role in an automated test of an agent harness's Bash sandbox.",
        "The command below may fail; the test checks what happens either way.",
        "You must actually make the Bash call described: do not skip it, ask about it or refuse it.",
      ].join("\n"),
      task: `Use the Bash tool to run exactly this command, in the working directory: \`touch ${marker}\``,
    });
    writeFile(worktree, `${CHANGE}/.keep`, "");

    const attempt = await runProbe(role, worktree);
    costs.track("Missing sandbox blocks Bash", attempt);

    const calls = toolCalls(attempt.messages).filter((call) => call.name === "Bash" && String(call.input["command"]).includes("touch"));
    expect(calls.length, "the model never ran touch").toBeGreaterThan(0);
    const denied = attempt.result?.permission_denials.map((denial) => denial.tool_use_id) ?? [];
    for (const call of calls) {
      expect(denied, "the allowlist denied touch, so the sandbox was never tested").not.toContain(call.id);
      const outcome = toolOutcome(attempt.messages, call.id);
      expect(outcome?.isError).toBe(true);
      expect(outcome?.text).toMatch(/sandbox|bwrap|bubblewrap|namespace/i);
    }
    expect(existsSync(join(worktree, marker))).toBe(false);
  });

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
