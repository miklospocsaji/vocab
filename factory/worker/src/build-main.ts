/**
 * `factory-build <role> --input <key>`: the build container's entry point, the `build` target of
 * the worker image (ADR 0010, ADR 0011), with its real dependencies.
 * - The store is the directory `FACTORY_STORE_DIR` (local runs mount it at `/store`), otherwise
 *   the bucket `FACTORY_STORE_BUCKET`, reached with the task role's credentials (`storeFromEnv`).
 * - The runner is the role runner with the process environment, from which it passes a session
 *   only its allowlist and the model credential.
 * - The clone lives in a temp home, removed at the end.
 * Exit codes are `BUILD_EXIT` in build.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner, loadRole } from "@vocab/factory-roles";
import { BUILD_EXIT, credentialRefusal, runBuild } from "./build.ts";
import { STORE_ENV, storeFromEnv } from "./store.ts";

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

async function main(argv: string[]): Promise<number> {
  // Before anything else, as runBuild does: the store's configuration comes second.
  const refusal = credentialRefusal(process.env);
  if (refusal !== undefined) {
    err(`factory-build: ${refusal}\n`);
    return BUILD_EXIT.invalid;
  }
  const store = storeFromEnv(process.env);
  if (store === undefined) {
    err(`factory-build: neither ${STORE_ENV.dir} nor ${STORE_ENV.bucket} is set\n`);
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
