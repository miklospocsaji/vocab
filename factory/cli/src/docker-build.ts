/**
 * The local build runner (add-build-loop design, "Local runs"): `docker run --rm` of the locally
 * built `build` image, with the store directory mounted at `/store`. The build reads its role,
 * input and, for a gates-only run, patch from the task's `next.json`, passed as arguments.
 * `docker` gets only the variables it needs to run, and the model credential, which it passes on
 * by name: the token never appears on the command line, and nothing else of the factory's
 * (the ledger URL, GitHub tokens) reaches the container.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nextBuildKey, parseNextBuild, type RunBuild } from "@vocab/factory-orchestrator";
import { FsStore } from "@vocab/factory-worker/store";

/** The tag of the locally built `build` target. */
export const LOCAL_BUILD_IMAGE = "vocab-factory-build:local";

/** Runs a command and resolves when it exits 0; rejects otherwise. */
export type Exec = (file: string, args: readonly string[], options: { env: Record<string, string | undefined> }) => Promise<void>;

export interface DockerBuildOptions {
  /** The host directory of the FsStore, mounted at `/store`. */
  storeDir: string;
  /** Defaults to LOCAL_BUILD_IMAGE. */
  image?: string;
  /** The environment `docker` runs with; the model credential is passed from it by name. */
  env: Record<string, string | undefined>;
  /** Defaults to running the command with execFile. */
  exec?: Exec;
}

const MODEL_CREDENTIAL = "CLAUDE_CODE_OAUTH_TOKEN";
/** What `docker` itself needs from the environment. */
const DOCKER_ENV = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"] as const;

const run = promisify(execFile);

const defaultExec: Exec = async (file, args, options) => {
  // The build's own log goes to the terminal; it never holds the token (the build redacts it).
  const child = run(file, [...args], { env: options.env, maxBuffer: 64 * 1024 * 1024 });
  child.child.stdout?.pipe(process.stderr);
  child.child.stderr?.pipe(process.stderr);
  await child;
};

export function dockerBuildRunner(options: DockerBuildOptions): RunBuild {
  const { storeDir, image = LOCAL_BUILD_IMAGE, env, exec = defaultExec } = options;
  const store = new FsStore(storeDir);
  return async ({ changeId, taskId }) => {
    const key = nextBuildKey(changeId, taskId);
    if (!(await store.exists(key))) throw new Error(`task ${taskId} of ${changeId} has no next build (${key})`);
    const next = parseNextBuild(await store.get(key));
    const token = env[MODEL_CREDENTIAL];
    if (token === undefined || token === "") throw new Error(`${MODEL_CREDENTIAL} is not set; add it to .env.local (ADR 0006)`);

    const dockerEnv: Record<string, string | undefined> = { [MODEL_CREDENTIAL]: token };
    for (const name of DOCKER_ENV) if (env[name] !== undefined) dockerEnv[name] = env[name];
    const args = [
      "run",
      "--rm",
      "--volume",
      `${storeDir}:/store`,
      "--env",
      "FACTORY_STORE_DIR=/store",
      "--env",
      MODEL_CREDENTIAL,
      image,
      next.role,
      "--input",
      next.input,
      ...(next.mode === "gates-only" && next.patch !== undefined ? ["--patch", next.patch] : []),
    ];
    await exec("docker", args, { env: dockerEnv });
  };
}
