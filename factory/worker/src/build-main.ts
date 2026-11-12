/**
 * `factory-build <role> --input <key>`: the build container's entry point, the `build` target of
 * the worker image (ADR 0010, ADR 0011), with its real dependencies.
 * - The store is the directory `FACTORY_STORE_DIR` (local runs mount it at `/store`), otherwise
 *   the bucket `FACTORY_ARTIFACT_BUCKET`, reached with the task role's credentials.
 * - The runner is the role runner with the process environment, from which it passes a session
 *   only its allowlist and the model credential.
 * - The clone lives in a temp home, removed at the end.
 * Exit codes are `BUILD_EXIT` in build.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { createRunner, loadRole } from "@vocab/factory-roles";
import { BUILD_EXIT, credentialRefusal, runBuild } from "./build.ts";
import { FsStore, S3Store, type ArtifactStore } from "./store.ts";

/** The factory's region (brief, section 5), if the task's environment does not name one. */
const DEFAULT_REGION = "eu-central-1";

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

function artifactStore(env: NodeJS.ProcessEnv): ArtifactStore | undefined {
  const dir = env["FACTORY_STORE_DIR"];
  if (dir !== undefined && dir !== "") return new FsStore(dir);
  const bucket = env["FACTORY_ARTIFACT_BUCKET"];
  if (bucket !== undefined && bucket !== "") return new S3Store({ bucket, client: new S3Client({ region: env["AWS_REGION"] ?? DEFAULT_REGION }) });
  return undefined;
}

async function main(argv: string[]): Promise<number> {
  // Before anything else, as runBuild does: the store's configuration comes second.
  const refusal = credentialRefusal(process.env);
  if (refusal !== undefined) {
    err(`factory-build: ${refusal}\n`);
    return BUILD_EXIT.invalid;
  }
  const store = artifactStore(process.env);
  if (store === undefined) {
    err("factory-build: neither FACTORY_STORE_DIR nor FACTORY_ARTIFACT_BUCKET is set\n");
    return BUILD_EXIT.invalid;
  }
  const home = await mkdtemp(join(tmpdir(), "factory-build-"));
  try {
    return await runBuild(argv, {
      env: process.env,
      store,
      home,
      createRunRole: ({ recorder, container }) => createRunner({ recorder, container, env: process.env }),
      loadRole: (name) => loadRole(name),
      out,
      err,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  err(`factory-build: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = BUILD_EXIT.error;
}
