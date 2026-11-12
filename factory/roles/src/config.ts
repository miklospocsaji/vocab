/**
 * Loads a role: `factory/roles/<role>.yaml`, validated with zod, plus its prompt from
 * `factory/roles/<role>.md`, which is never in `.claude/agents` (ADR 0012). An invalid config or
 * a missing prompt throws a RoleConfigError naming the role and the field, before any session
 * starts.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resultSchemas } from "@vocab/factory-artifacts";
import { escape } from "minimatch";
import { parse } from "yaml";
import { z } from "zod";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CHANGE_ID = "{changeId}";
const TASK_STUBS = "{taskStubs}";

/** True for the Bash tool and for any `Bash(...)` rule. */
const isBash = (entry: string): boolean => entry === "Bash" || entry.startsWith("Bash(");

/**
 * Bash rules the runner denies in every session, whatever the role's allowlist (SDK
 * `disallowedTools`; deny wins over allow). They match command strings, so they stop the
 * model's own commands, not code those commands run (design.md, accepted risks).
 */
export const DENY_LIST: readonly string[] = [
  "Bash(git push:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(nc:*)",
  "Bash(pnpm add:*)",
  "Bash(pnpm install:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
];

/** The command prefix each denied rule matches. */
const DENIED_COMMANDS = DENY_LIST.map((rule) => rule.slice("Bash(".length, -":*)".length));

/**
 * The denied command an allow rule would grant, if any: a bare `Bash` grants all; a rule with a
 * wildcard grants every command starting with the part before it; a rule without one grants that
 * command. It overlaps when one side's prefix starts with the other's.
 */
function deniedBy(rule: string): string | undefined {
  if (rule === "Bash") return DENIED_COMMANDS[0];
  if (!rule.startsWith("Bash(") || !rule.endsWith(")")) return undefined;
  const body = rule.slice("Bash(".length, -1);
  const star = body.indexOf("*");
  if (star === -1) return DENIED_COMMANDS.find((command) => body.startsWith(command));
  const prefix = body.slice(0, star).replace(/:$/, "");
  return DENIED_COMMANDS.find((command) => command.startsWith(prefix) || prefix.startsWith(command));
}

export const RoleConfigSchema = z.strictObject({
  name: z.string().min(1),
  model: z.string().min(1),
  /** Where the role may run: the worker, or the build container that alone runs Bash (ADR 0011). */
  runsIn: z.enum(["worker", "build"]),
  /** The role's whole tool set, passed to SDK `tools`. */
  tools: z.array(z.string().min(1)),
  /** Pre-approved calls, passed to SDK `allowedTools`. */
  allow: z.array(z.string().min(1)),
  /**
   * Globs relative to the worktree; `{changeId}` is filled in per work item. A `!` glob excludes
   * what it matches. The entry `{taskStubs}` stands for the task's new source files. Empty means
   * read-only.
   */
  writable: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
  maxTurns: z.int().positive(),
  maxBudgetUsd: z.number().positive(),
  resultSchema: z.string().refine((id) => Object.hasOwn(resultSchemas, id), "unknown result schema"),
  authMode: z.enum(["api-key", "subscription"]),
}).superRefine((config, ctx) => {
  for (const rule of config.allow) {
    const denied = deniedBy(rule);
    if (denied !== undefined) ctx.addIssue({ code: "custom", path: ["allow"], message: `${rule} would allow ${denied}, which the runner always denies` });
  }
  // Bash runs only in the build container: the worker holds every factory secret (ADR 0011).
  if (config.runsIn !== "worker") return;
  if (config.tools.some(isBash)) ctx.addIssue({ code: "custom", path: ["tools"], message: "a role that runs in the worker cannot have Bash" });
  if (config.allow.some(isBash)) ctx.addIssue({ code: "custom", path: ["allow"], message: "a role that runs in the worker cannot pre-approve Bash" });
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export interface Role extends RoleConfig {
  /** The system prompt: `factory/roles/<role>.md`, with any frontmatter stripped. */
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
  const promptPath = join("factory/roles", `${name}.md`);

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

/**
 * The role's writable globs for one work item: `{changeId}` filled in, and the entry
 * `{taskStubs}` replaced by the given files, each matched literally. With no stubs, the entry is
 * dropped.
 */
export function writableFor(role: Pick<RoleConfig, "writable">, changeId: string, taskStubs: readonly string[] = []): string[] {
  return role.writable.flatMap((glob) =>
    glob === TASK_STUBS ? taskStubs.map((file) => escape(file)) : [glob.replaceAll(CHANGE_ID, changeId)],
  );
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
