/**
 * The comment posted on the issue when a run stops after Proposal: why and what changes
 * (from the pushed `proposal.md`), the affected capabilities, complexity and open questions
 * (from the proposal author's result), and where to review it. In the cloud it also shows the
 * proposal's cost and ends by asking the owner to reply `/approve`; the local CLI's summary
 * stays as in M1. A `large` change's design gets a summary of its own, for the owner's approval.
 */
import type { DesignResult, ProposalResult } from "@vocab/factory-artifacts";
import type { AuthMode, TokenUsage } from "@vocab/factory-ledger";

/** What the proposal cost, over all its attempts. */
export interface ProposalCost {
  tokens: TokenUsage;
  /** The SDK's estimate, in USD. */
  usd: number;
  /** The auth modes its attempts ran in; empty when none was recorded. */
  authModes: AuthMode[];
}

export interface ProposalSummaryInput {
  changeId: string;
  branch: string;
  result: ProposalResult;
  /** The change's `proposal.md`; its Why and What Changes sections are quoted when present. */
  proposal?: string;
  /** Shown as a cost line when given. */
  cost?: ProposalCost;
  /** Ends the comment with the instruction to reply `/approve`. */
  askForApproval?: boolean;
}

/** The comment's last paragraph in the cloud. */
export const APPROVAL_INSTRUCTION = "To approve the proposal, reply `/approve` on this issue.";

/** The design summary's last paragraph. */
export const DESIGN_APPROVAL_INSTRUCTION = "To approve the design, reply `/approve` on this issue.";

export function renderProposalSummary(input: ProposalSummaryInput): string {
  const { changeId, branch, result, proposal = "", cost, askForApproval = false } = input;
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
      ...(cost === undefined ? [] : [`- **Cost:** ${costLine(cost)}`]),
    ].join("\n"),
    "### Open questions",
    questions.join("\n"),
    `Review the change in \`openspec/changes/${changeId}/\` on branch \`${branch}\`. The work item is now \`awaiting-proposal-approval\`.`,
    ...(askForApproval ? [APPROVAL_INSTRUCTION] : []),
  ].join("\n\n");
}

export interface DesignSummaryInput {
  changeId: string;
  branch: string;
  /** The architect's result for the design on the branch. */
  result: DesignResult;
  /** What Design cost, over all its attempts. */
  cost: ProposalCost;
}

/**
 * The comment for a `large` change's design: the architect's summary, the contracts it changed,
 * the decisions that need an ADR, its open questions and cost, and the approval instruction.
 */
export function renderDesignSummary(input: DesignSummaryInput): string {
  const { changeId, branch, result, cost } = input;
  const list = (items: readonly string[], none: string, code = false) =>
    items.length === 0 ? none : items.map((item) => `- ${code ? `\`${item}\`` : item}`).join("\n");
  return [
    `## Design ready: \`${changeId}\``,
    result.summary,
    [`- **Change id:** \`${changeId}\``, `- **Branch:** \`${branch}\``, `- **Cost:** ${costLine(cost)}`].join("\n"),
    "### Contracts",
    list(result.contracts, "No changes in `app/contracts/`.", true),
    "### Decisions that need an ADR",
    list(result.adrNeeded, "None."),
    "### Open questions",
    list(result.openQuestions, "None."),
    `Review \`openspec/changes/${changeId}/design.md\` on branch \`${branch}\`. The work item is now \`awaiting-design-approval\`.`,
    DESIGN_APPROVAL_INSTRUCTION,
  ].join("\n\n");
}

const count = (n: number): string => n.toLocaleString("en-US");

/** `3,000 tokens (input 2,000, output 1,000, cache read 0, cache write 0), about $0.75 estimated, auth mode `api-key``. */
function costLine(cost: ProposalCost): string {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = cost.tokens;
  const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const usd = cost.usd > 0 && cost.usd < 0.01 ? cost.usd.toFixed(4) : cost.usd.toFixed(2);
  const modes = cost.authModes.length === 0 ? "unknown" : cost.authModes.map((mode) => `\`${mode}\``).join(", ");
  return [
    `${count(total)} tokens (input ${count(inputTokens)}, output ${count(outputTokens)}, cache read ${count(cacheReadTokens)}, cache write ${count(cacheCreationTokens)})`,
    `about $${usd} estimated`,
    `auth mode ${modes}`,
  ].join(", ");
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
