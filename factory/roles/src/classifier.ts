/**
 * The failure classifier's prompt (add-build-roles design.md, "The failure classifier"): the
 * failed gates' result, the task and the changed paths. The gate result and the paths come from
 * agent-written code, so both are fenced as untrusted data; the task comes from the validated plan.
 */
import type { GatesResult } from "@vocab/factory-artifacts";
import { untrusted } from "./prompt.ts";

export interface ClassifierInput {
  changeId: string;
  task: { id: string; title: string; scenarios: readonly string[] };
  /** The failed `gates.json`. */
  gates: GatesResult;
  /** The paths the attempt changed, from its diff check. */
  changedPaths: readonly string[];
}

export function renderClassifierPrompt(input: ClassifierInput): string {
  const { changeId, task, gates, changedPaths } = input;
  const failed = gates.checks.filter((check) => !check.passed).map((check) => check.name);
  const sections = [
    `# Failed gates: ${changeId}, task ${task.id}`,
    `The ${gates.mode} gates failed for task ${task.id} of the change \`${changeId}\`. Failed checks: ${failed.length > 0 ? failed.join(", ") : "none reported"}.`,
    "## Task",
    [`Task ${task.id}: ${task.title}`, "", "Scenarios this task makes pass:", ...task.scenarios.map((title) => `- ${title}`)].join("\n"),
    "## Changed paths",
    changedPaths.length === 0 ? "The attempt changed no paths." : untrusted("list of changed paths", changedPaths.join("\n"), "changed-paths", "evidence about the failure"),
    "## Gate result",
    untrusted("gate result", JSON.stringify(gates, null, 2), "gates-result", "evidence about the failure"),
    "Classify the failure and return your result.",
  ];
  return `${sections.join("\n\n")}\n`;
}
