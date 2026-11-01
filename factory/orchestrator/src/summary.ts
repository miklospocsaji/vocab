/**
 * The comment posted on the issue when a run stops after Proposal: why and what changes
 * (from the pushed `proposal.md`), the affected capabilities, complexity and open questions
 * (from the proposal author's result), and where to review it.
 */
import type { ProposalResult } from "@vocab/factory-artifacts";

export interface ProposalSummaryInput {
  changeId: string;
  branch: string;
  result: ProposalResult;
  /** The change's `proposal.md`; its Why and What Changes sections are quoted when present. */
  proposal?: string;
}

export function renderProposalSummary(input: ProposalSummaryInput): string {
  const { changeId, branch, result, proposal = "" } = input;
  const why = section(proposal, "Why");
  const what = section(proposal, "What Changes");
  const questions = result.openQuestions.length === 0 ? ["None."] : result.openQuestions.map((question) => `- ${question}`);

  return [
    `## Proposal ready: \`${changeId}\``,
    result.summary,
    ...(why === undefined ? [] : ["### Why", why]),
    ...(what === undefined ? [] : ["### What changes", what]),
    [
      `- **Change id:** \`${changeId}\``,
      `- **Branch:** \`${branch}\``,
      `- **Affected capabilities:** ${result.capabilities.map((capability) => `\`${capability}\``).join(", ")}`,
      `- **Complexity:** ${result.complexity}`,
    ].join("\n"),
    "### Open questions",
    questions.join("\n"),
    `Review the change in \`openspec/changes/${changeId}/\` on branch \`${branch}\`. The work item is now \`awaiting-proposal-approval\`.`,
  ].join("\n\n");
}

/** The body of the `## <title>` section of a markdown document, trimmed; undefined when absent or empty. */
function section(markdown: string, title: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${title.toLowerCase()}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? undefined : body;
}
