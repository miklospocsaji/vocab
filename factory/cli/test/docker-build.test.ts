// The Docker build runner of local runs (add-build-loop task 3.11), with a fake exec.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nextBuildKey } from "@vocab/factory-orchestrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "../../worker/src/store.ts";
import { dockerBuildRunner, LOCAL_BUILD_IMAGE, type Exec } from "../src/docker-build.ts";

const CHANGE_ID = "add-import-kindle-vocab-db";
const TOKEN = "sk-ant-oat01-local-test-token";
const INPUT = `work-items/${CHANGE_ID}/tasks/1.1/implementer/1/input.json`;

let root: string;
let store: FsStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "factory-docker-build-"));
  store = new FsStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function recordingExec(): { exec: Exec; calls: { file: string; args: readonly string[]; env: Record<string, string | undefined> }[] } {
  const calls: { file: string; args: readonly string[]; env: Record<string, string | undefined> }[] = [];
  return {
    calls,
    exec: (file, args, options) => {
      calls.push({ file, args, env: options.env });
      return Promise.resolve();
    },
  };
}

describe("dockerBuildRunner", () => {
  it("runs the build image on the task's next input, with the store mounted and the token passed by name", async () => {
    await store.put(nextBuildKey(CHANGE_ID, "1.1"), JSON.stringify({ role: "implementer", mode: "session", input: INPUT }));
    const { exec, calls } = recordingExec();

    await dockerBuildRunner({ storeDir: root, env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, FACTORY_DATABASE_URL: "postgres://x" }, exec })({ changeId: CHANGE_ID, taskId: "1.1" });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.file).toBe("docker");
    expect(call?.args).toEqual([
      "run",
      "--rm",
      "--volume",
      `${root}:/store`,
      "--env",
      "FACTORY_STORE_DIR=/store",
      "--env",
      "CLAUDE_CODE_OAUTH_TOKEN",
      LOCAL_BUILD_IMAGE,
      "implementer",
      "--input",
      INPUT,
    ]);
    // The token never appears on the command line; docker reads it from its own environment.
    expect(call?.args.join(" ")).not.toContain(TOKEN);
    expect(call?.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(TOKEN);
    // Nothing else of the factory's reaches docker's environment.
    expect(call?.env["FACTORY_DATABASE_URL"]).toBeUndefined();
  });

  it("passes the patch of a gates-only build", async () => {
    const patch = `work-items/${CHANGE_ID}/tasks/1.1/implementer/1/patch.diff`;
    const rerun = `work-items/${CHANGE_ID}/tasks/1.1/implementer/2/input.json`;
    await store.put(nextBuildKey(CHANGE_ID, "1.1"), JSON.stringify({ role: "implementer", mode: "gates-only", input: rerun, patch }));
    const { exec, calls } = recordingExec();

    await dockerBuildRunner({ storeDir: root, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, exec })({ changeId: CHANGE_ID, taskId: "1.1" });

    expect(calls[0]?.args.slice(-5)).toEqual(["implementer", "--input", rerun, "--patch", patch]);
  });

  it("makes the attempt's folder writable for the container's user, and nothing above it", async () => {
    await store.put(INPUT, "{}");
    await store.put(nextBuildKey(CHANGE_ID, "1.1"), JSON.stringify({ role: "implementer", mode: "session", input: INPUT }));
    const { exec } = recordingExec();

    await dockerBuildRunner({ storeDir: root, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, exec })({ changeId: CHANGE_ID, taskId: "1.1" });

    // The build image runs as its own user, so it writes its outputs into a folder the owner owns.
    expect(statSync(join(root, dirname(INPUT))).mode & 0o777).toBe(0o777);
    expect(statSync(join(root, dirname(dirname(INPUT)))).mode & 0o002).toBe(0);
  });

  it("refuses a next build whose input key leaves the store", async () => {
    await store.put(nextBuildKey(CHANGE_ID, "1.1"), JSON.stringify({ role: "implementer", mode: "session", input: "work-items/../../etc/input.json" }));
    const { exec, calls } = recordingExec();

    await expect(dockerBuildRunner({ storeDir: root, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, exec })({ changeId: CHANGE_ID, taskId: "1.1" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses a task with no next build", async () => {
    const { exec, calls } = recordingExec();

    await expect(dockerBuildRunner({ storeDir: root, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, exec })({ changeId: CHANGE_ID, taskId: "1.1" })).rejects.toThrow(/next/);
    expect(calls).toEqual([]);
  });

  it("refuses to start without the model credential", async () => {
    await store.put(nextBuildKey(CHANGE_ID, "1.1"), JSON.stringify({ role: "implementer", mode: "session", input: INPUT }));
    const { exec, calls } = recordingExec();

    await expect(dockerBuildRunner({ storeDir: root, env: {}, exec })({ changeId: CHANGE_ID, taskId: "1.1" })).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(calls).toEqual([]);
  });
});
