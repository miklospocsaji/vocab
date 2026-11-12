/**
 * Reading a work item's change folder and the current specs from its worktree, for role
 * prompts, and the change's `x-complexity` from `.openspec.yaml`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Complexity } from "@vocab/factory-artifacts";
import type { PromptArtifact } from "@vocab/factory-roles";

/** `openspec/changes/<id>`, relative to the worktree. */
export const changeFolder = (changeId: string): string => `openspec/changes/${changeId}`;

/** Every file in the change folder, paths relative to the worktree, sorted. */
export async function changeFiles(worktree: string, changeId: string): Promise<PromptArtifact[]> {
  const folder = join(worktree, changeFolder(changeId));
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const paths = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return artifacts(worktree, paths);
}

/**
 * The current `openspec/specs/<capability>/spec.md` files. Roles decide or check which
 * capabilities a change affects, so they get all of them.
 */
export async function currentSpecs(worktree: string): Promise<PromptArtifact[]> {
  const specs = join(worktree, "openspec/specs");
  if (!(await exists(specs))) return [];
  const capabilities = await readdir(specs, { withFileTypes: true });
  const paths = capabilities.filter((entry) => entry.isDirectory()).map((entry) => join(specs, entry.name, "spec.md"));
  const present = await Promise.all(paths.map(async (path) => ((await exists(path)) ? [path] : [])));
  return artifacts(worktree, present.flat());
}

async function artifacts(worktree: string, paths: string[]): Promise<PromptArtifact[]> {
  const sorted = paths.map((path) => relative(worktree, path)).sort();
  return Promise.all(sorted.map(async (path) => ({ path, content: await readFile(join(worktree, path), "utf8") })));
}

/** A file's content, or undefined when it does not exist; any other error rejects. */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** `x-complexity` as `.openspec.yaml` states it: a known value, or what is there instead. */
export type ComplexityReading = { ok: true; complexity: Complexity } | { ok: false; problem: string };

/**
 * The top-level `x-complexity` of an `.openspec.yaml`. The file is flat `key: value` YAML, so
 * the one key is read by line, optionally quoted, with a trailing comment allowed.
 */
export function readComplexity(metadata: string | undefined): ComplexityReading {
  if (metadata === undefined) return { ok: false, problem: "the change has no `.openspec.yaml`" };
  const match = /^x-complexity:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]*))[ \t]*(?:#.*)?$/m.exec(metadata);
  if (match === null) return { ok: false, problem: "`.openspec.yaml` has no `x-complexity`" };
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  const parsed = Complexity.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problem: `\`x-complexity\` in \`.openspec.yaml\` is \`${value}\`, not one of ${Complexity.options.map((option) => `\`${option}\``).join(", ")}` };
  }
  return { ok: true, complexity: parsed.data };
}
