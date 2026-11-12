/**
 * `factory-build <role> --input <key>`: one build role's attempt in the build container
 * (ADR 0011; add-build-roles design.md, "The build container"). Every dependency is passed in;
 * `build-main.ts` wires in the real ones.
 *
 * 1. Refuse to start (exit 2) if the environment holds any factory credential other than the
 *    model credential. The error names the variable, never its value.
 * 2. Read `input.json` from the store; check it, and that the role runs in the build container.
 * 3. Clone the branch with no token into `<home>/work`, check out `baseCommit`, install.
 * 4. Run the role, recording its messages to `messages.jsonl` rather than the ledger.
 * 5. Run the diff check against `baseCommit`, from the input and never from the clone's HEAD.
 * 6. If the session and the diff check passed, run the gates: red after the test author, green
 *    after the implementer, with the model credential's value redacted.
 * 7. Write `patch.diff`, `gates.json` (if the gates ran), `messages.jsonl` and, last,
 *    `outcome.json`, next to the input key.
 *
 * Exit 0 when the outcome is written, whether it passed or failed; 1 on a crash, with no outcome;
 * 2 on bad input.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import { BuildOutcome, PlanResult, type GatesResult } from "@vocab/factory-artifacts";
import { redact, runGates as defaultRunGates, type RunGatesOptions } from "@vocab/factory-gates";
import {
  AttemptFailed,
  diffCheck,
  diffPatch,
  JsonlRecorder,
  RoleConfigError,
  renderTaskPrompt,
  writableFor,
  type PromptArtifact,
  type Recorder,
  type Role,
  type RunRole,
} from "@vocab/factory-roles";
import { z } from "zod";
import { checkKey, InvalidStoreKey, type ArtifactStore } from "./store.ts";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export const BUILD_EXIT = { ok: 0, error: 1, invalid: 2 } as const;

export const BUILD_USAGE = "Usage: factory-build <role> --input <key>\n";

/** Factory credentials other than the model credential: the build container refuses to start with any of them (ADR 0011). */
export const FACTORY_CREDENTIALS = [
  "FACTORY_GITHUB_APP_PRIVATE_KEY",
  "FACTORY_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "FACTORY_LEDGER_SECRET",
  "FACTORY_DATABASE_URL",
  "FACTORY_WEBHOOK_SECRET",
] as const;

/** The model credentials, whose values are redacted from the gates' output and from errors. */
const MODEL_CREDENTIALS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** Which gates follow which build role. */
const GATE_MODE: Readonly<Record<string, RunGatesOptions["mode"]>> = {
  "test-author": "red",
  implementer: "green",
};

const TASK_STUBS = "{taskStubs}";
const ROLE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** `input.json`: what the worker hands one build container run. */
export const BuildInput = z.strictObject({
  changeId: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/, "a change id"),
  branch: z.string().min(1),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/, "a full commit SHA"),
  /** Cloned with no token. */
  cloneUrl: z.string().min(1),
  task: PlanResult.shape.tasks.element,
  /** The evidence of the role's earlier attempts: the gate result, the classification, the diff check. */
  evidence: z.strictObject({ reason: z.string().min(1), evidence: z.string() }).optional(),
  /** Green gates: the scenario titles of every task done so far, this one included. */
  coveredSoFar: z.array(z.string()).optional(),
});
export type BuildInput = z.infer<typeof BuildInput>;

export interface BuildDeps {
  env: Record<string, string | undefined>;
  store: ArtifactStore;
  /** The run's home: the clone goes to `<home>/work`. */
  home: string;
  /** The role runner around the run's recorder; the container is `build` only when `FACTORY_CONTAINER=build`. */
  createRunRole: (options: { recorder: Recorder; container: "worker" | "build" }) => RunRole;
  loadRole: (name: string) => Promise<Role>;
  /** Installs the clone's dependencies; defaults to an offline pnpm install. */
  install?: (worktree: string) => Promise<void>;
  /** Defaults to the gates of add-build-gates. */
  runGates?: (options: RunGatesOptions) => Promise<GatesResult>;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Why the build container must not start, naming each factory credential set (never its value); undefined if none is. */
export function credentialRefusal(env: Record<string, string | undefined>): string | undefined {
  const present = FACTORY_CREDENTIALS.filter((name) => env[name] !== undefined);
  if (present.length === 0) return undefined;
  return `refusing to start: ${present.join(", ")} must not be set; the build container holds only the model credential`;
}

/** Input the build refuses with exit 2. */
class InvalidInput extends Error {}

export async function runBuild(argv: string[], deps: BuildDeps): Promise<number> {
  const refusal = credentialRefusal(deps.env);
  if (refusal !== undefined) {
    deps.err(`factory-build: ${refusal}\n`);
    return BUILD_EXIT.invalid;
  }
  const secrets = MODEL_CREDENTIALS.flatMap((name) => deps.env[name] ?? []);

  try {
    const { roleName, inputKey } = parseBuildArgs(argv);
    const input = await readInput(deps.store, inputKey);
    const role = await requireBuildRole(deps, roleName);
    return await build(deps, role, input, inputKey, secrets);
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), secrets);
    if (error instanceof InvalidInput) {
      deps.err(`factory-build: ${message}\n${error.message.startsWith("usage") ? `\n${BUILD_USAGE}` : ""}`);
      return BUILD_EXIT.invalid;
    }
    deps.err(`factory-build: ${message}\n`);
    return BUILD_EXIT.error;
  }
}

function parseBuildArgs(argv: string[]): { roleName: string; inputKey: string } {
  let positionals: string[];
  let inputKey: string | undefined;
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { input: { type: "string" } } });
    positionals = parsed.positionals;
    inputKey = parsed.values.input;
  } catch (error) {
    throw new InvalidInput(`usage: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [roleName, ...rest] = positionals;
  if (roleName === undefined) throw new InvalidInput("usage: no role given");
  if (rest.length > 0) throw new InvalidInput(`usage: unexpected argument ${rest[0] ?? ""}`);
  if (!ROLE_NAME.test(roleName)) throw new InvalidInput("usage: the role must be a role name");
  if (inputKey === undefined) throw new InvalidInput("usage: --input is required");
  try {
    checkKey(inputKey);
  } catch (error) {
    if (error instanceof InvalidStoreKey) throw new InvalidInput(error.message);
    throw error;
  }
  return { roleName, inputKey };
}

async function readInput(store: ArtifactStore, key: string): Promise<BuildInput> {
  let raw: string;
  try {
    raw = await store.get(key);
  } catch (error) {
    throw new InvalidInput(`cannot read the input ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new InvalidInput(`the input ${key} is not JSON`);
  }
  const parsed = BuildInput.safeParse(data);
  if (!parsed.success) throw new InvalidInput(`the input ${key} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

async function requireBuildRole(deps: BuildDeps, name: string): Promise<Role> {
  let role: Role;
  try {
    role = await deps.loadRole(name);
  } catch (error) {
    throw new InvalidInput(error instanceof Error ? error.message : String(error));
  }
  if (role.runsIn !== "build") throw new InvalidInput(`role ${name} runs in the worker, not the build container`);
  if (GATE_MODE[name] === undefined) throw new InvalidInput(`role ${name} has no gates to run after it`);
  return role;
}

async function build(deps: BuildDeps, role: Role, input: BuildInput, inputKey: string, secrets: string[]): Promise<number> {
  const { store, env } = deps;
  const { changeId, baseCommit, task } = input;
  const mode = GATE_MODE[role.name] ?? "green";
  const prefix = posix.dirname(inputKey);
  const key = (file: string) => `${prefix}/${file}`;

  const worktree = join(deps.home, "work");
  await clone(input, worktree, env);
  await (deps.install ?? ((dir: string) => install(dir, env, deps.out)))(worktree);

  const stubs = role.writable.includes(TASK_STUBS) ? await newFiles(worktree, baseCommit, task.files) : [];
  const recorder = new JsonlRecorder();
  const runRole = deps.createRunRole({ recorder, container: env["FACTORY_CONTAINER"] === "build" ? "build" : "worker" });
  const prompt = renderTaskPrompt({
    changeId,
    task,
    changeFiles: await changeFiles(worktree, changeId),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });

  let roleResult: unknown;
  let reason: BuildOutcome["reason"];
  try {
    roleResult = await runRole(role, {
      id: `${changeId}/${task.id}`,
      changeId,
      worktree,
      issue: { title: "", body: "" },
      changeFiles: [],
      specs: [],
      taskStubs: stubs,
      prompt,
    });
  } catch (error) {
    if (error instanceof RoleConfigError) throw new InvalidInput(error.message);
    if (!(error instanceof AttemptFailed)) throw error;
    reason = error.reason;
  }

  const check = await diffCheck(worktree, baseCommit, writableFor(role, changeId, stubs), stubs);
  if (reason === undefined && !check.passed) reason = "diff-check";

  let gatesKey: string | undefined;
  if (reason === undefined) {
    const gates = await (deps.runGates ?? defaultRunGates)({
      worktree,
      changeId,
      task: { id: task.id, scenarios: task.scenarios, coveredSoFar: input.coveredSoFar },
      mode,
      secrets,
    });
    gatesKey = key("gates.json");
    await store.put(gatesKey, `${JSON.stringify(gates, null, 2)}\n`);
    if (!gates.passed) reason = mode;
  }

  const patchKey = key("patch.diff");
  const messagesKey = key("messages.jsonl");
  await store.put(patchKey, await diffPatch(worktree, baseCommit));
  await store.put(messagesKey, recorder.toJsonl());
  const outcome = BuildOutcome.parse({
    role: role.name,
    outcome: reason === undefined ? "passed" : "failed",
    ...(reason === undefined ? {} : { reason }),
    ...(roleResult === undefined ? {} : { roleResult }),
    diffCheck: check,
    ...(gatesKey === undefined ? {} : { gates: gatesKey }),
    patch: patchKey,
    messages: messagesKey,
    baseCommit,
  });
  await store.put(key("outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
  deps.out(`factory-build: ${role.name} for task ${task.id} of ${changeId}: ${outcome.outcome}${reason === undefined ? "" : ` (${reason})`}\n`);
  return BUILD_EXIT.ok;
}

/** No credential of any kind: git and pnpm see only these. */
function toolEnv(env: Record<string, string | undefined>): Record<string, string> {
  return {
    PATH: env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: env["HOME"] ?? "/tmp",
    TMPDIR: env["TMPDIR"] ?? "/tmp",
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The branch, cloned with no token, at `baseCommit`. */
async function clone(input: BuildInput, worktree: string, env: Record<string, string | undefined>): Promise<void> {
  const options = { env: toolEnv(env), maxBuffer: MAX_BUFFER };
  await run("git", ["clone", "--quiet", "--no-checkout", "--branch", input.branch, "--", input.cloneUrl, worktree], options);
  await run("git", ["checkout", "--quiet", "--detach", input.baseCommit], { ...options, cwd: worktree });
}

/**
 * `pnpm install --frozen-lockfile --offline` from the image's warm store
 * (`FACTORY_PNPM_STORE`). A branch whose lockfile differs from the image's falls back to an
 * online install, which is logged.
 */
async function install(worktree: string, env: Record<string, string | undefined>, out: (text: string) => void): Promise<void> {
  const store = env["FACTORY_PNPM_STORE"];
  const args = ["install", "--frozen-lockfile", ...(store === undefined ? [] : ["--store-dir", store])];
  const options = { cwd: worktree, env: toolEnv(env), maxBuffer: MAX_BUFFER };
  try {
    await run("pnpm", [...args, "--offline"], options);
  } catch {
    out("factory-build: online-install: the offline install failed, so the lockfile differs from the image's; installing online\n");
    await run("pnpm", args, options);
  }
}

/** The task's files that did not exist at `baseCommit`: the test author's stubs. */
async function newFiles(worktree: string, baseCommit: string, files: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    try {
      await run("git", ["cat-file", "-e", `${baseCommit}:${file}`], { cwd: worktree });
    } catch {
      found.push(file);
    }
  }
  return found;
}

/** Every file of `openspec/changes/<changeId>/` in the clone, sorted; none if the folder is missing. */
async function changeFiles(worktree: string, changeId: string): Promise<PromptArtifact[]> {
  const dir = join(worktree, "openspec/changes", changeId);
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: PromptArtifact[] = [];
  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EISDIR") continue;
      throw error;
    }
    files.push({ path: relative(worktree, path).split(sep).join("/"), content });
  }
  return files;
}
