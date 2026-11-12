/**
 * What the worker and the build container exchange through the artifact store (add-build-loop
 * design, "Worker states" and "Build task invocation"):
 * - `step` writes a build attempt's `input.json` under the attempt's prefix,
 *   `work-items/<changeId>/tasks/<taskId>/<role>/<n>`, and then points the task's `next.json` at it.
 * - The build reads `next.json` for its role, mode and input key, and writes its outputs next to
 *   the input: `patch.diff`, `gates.json`, `messages.jsonl` and, last, `outcome.json`.
 * The store is an interface here, so the orchestrator does not depend on the worker: the worker's
 * `FsStore` and `S3Store` both fit it.
 */

export interface ArtifactStore {
  /** Rejects when the key does not exist. */
  get(key: string): Promise<string>;
  put(key: string, body: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Runs the build that the task's `next.json` describes, and resolves when it has ended, whatever its outcome. */
export type RunBuild = (request: { changeId: string; taskId: string }) => Promise<void>;

/**
 * `next.json`: which build to run next for a task.
 * - `session`: run `role` on `input`, then its gates.
 * - `gates-only`: apply `patch` at the input's base commit and run the green gates, with no session.
 */
export interface NextBuild {
  role: string;
  mode: "session" | "gates-only";
  /** The store key of the attempt's `input.json`. */
  input: string;
  /** The store key of the patch to re-check, for `gates-only`. */
  patch?: string;
}

/** `work-items/<changeId>/tasks/<taskId>`: everything of one task's builds. */
export function taskPrefix(changeId: string, taskId: string): string {
  return `work-items/${changeId}/tasks/${taskId}`;
}

/** The key of a task's `next.json`. */
export function nextBuildKey(changeId: string, taskId: string): string {
  return `${taskPrefix(changeId, taskId)}/next.json`;
}

/** Parses a `next.json`; throws naming the problem. */
export function parseNextBuild(raw: string): NextBuild {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("next.json is not JSON");
  }
  const value = data as Partial<Record<keyof NextBuild, unknown>> | null;
  if (typeof value !== "object" || value === null) throw new Error("next.json is not an object");
  const { role, mode, input, patch } = value;
  if (typeof role !== "string" || role === "") throw new Error("next.json has no role");
  if (mode !== "session" && mode !== "gates-only") throw new Error("next.json has no valid mode");
  if (typeof input !== "string" || input === "") throw new Error("next.json has no input key");
  if (patch !== undefined && typeof patch !== "string") throw new Error("next.json has an invalid patch key");
  if (mode === "gates-only" && patch === undefined) throw new Error("a gates-only next.json needs a patch key");
  return { role, mode, input, ...(patch === undefined ? {} : { patch }) };
}
