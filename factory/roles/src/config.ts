/**
 * Loads a role: `factory/roles/<role>.yaml`, validated with zod, plus its prompt from
 * `.claude/agents/<role>.md` with the frontmatter stripped. An invalid config or a missing
 * prompt throws a RoleConfigError naming the role and the field, before any session starts.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resultSchemas } from "@vocab/factory-artifacts";
import { parse } from "yaml";
import { z } from "zod";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CHANGE_ID = "{changeId}";

export const RoleConfigSchema = z.strictObject({
  name: z.string().min(1),
  model: z.string().min(1),
  /** The role's whole tool set, passed to SDK `tools`. */
  tools: z.array(z.string().min(1)),
  /** Pre-approved calls, passed to SDK `allowedTools`. */
  allow: z.array(z.string().min(1)),
  /** Globs relative to the worktree; `{changeId}` is filled in per work item. Empty means read-only. */
  writable: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
  maxTurns: z.int().positive(),
  maxBudgetUsd: z.number().positive(),
  resultSchema: z.string().refine((id) => Object.hasOwn(resultSchemas, id), "unknown result schema"),
  authMode: z.enum(["api-key", "subscription"]),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export interface Role extends RoleConfig {
  /** The system prompt: `.claude/agents/<role>.md` without its frontmatter. */
  prompt: string;
  schema: z.ZodType;
}

export class RoleConfigError extends Error {
  readonly role: string;
  readonly field: string;

  constructor(role: string, field: string, detail: string) {
    super(`role ${role}: invalid ${field}: ${detail}`);
    this.name = "RoleConfigError";
    this.role = role;
    this.field = field;
  }
}

export interface LoadRoleOptions {
  /** The repository (or worktree) root; defaults to this repo. */
  root?: string;
}

export async function loadRole(name: string, options: LoadRoleOptions = {}): Promise<Role> {
  const root = options.root ?? REPO_ROOT;
  const configPath = join("factory/roles", `${name}.yaml`);
  const promptPath = join(".claude/agents", `${name}.md`);

  const raw = await readText(name, "config", root, configPath);
  let data: unknown;
  try {
    data = parse(raw);
  } catch (error) {
    throw new RoleConfigError(name, "config", `${configPath} is not valid YAML: ${String(error)}`);
  }

  const parsed = RoleConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "config";
    throw new RoleConfigError(name, field, issue?.message ?? "invalid");
  }
  const config = parsed.data;
  if (config.name !== name) {
    throw new RoleConfigError(name, "name", `${configPath} names the role ${config.name}`);
  }

  const prompt = stripFrontmatter(await readText(name, "prompt", root, promptPath));
  const schema = resultSchemas[config.resultSchema];
  if (schema === undefined) throw new RoleConfigError(name, "resultSchema", "unknown result schema");
  return { ...config, prompt, schema };
}

/** The role's writable globs for one work item, with `{changeId}` filled in. */
export function writableFor(role: Pick<RoleConfig, "writable">, changeId: string): string[] {
  return role.writable.map((glob) => glob.replaceAll(CHANGE_ID, changeId));
}

export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

async function readText(role: string, field: string, root: string, path: string): Promise<string> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : String(error);
    throw new RoleConfigError(role, field, `${path} is ${reason}`);
  }
}
