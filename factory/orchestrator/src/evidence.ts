/**
 * Evidence in escalation comments: an `openspec validate --json` report as a list of its issues,
 * reviewer findings as a list, and anything else fenced so it cannot close its fence.
 */

export interface Finding {
  severity: string;
  location: string;
  summary: string;
}

/** An `openspec validate --json` report as a list of its issues; any other evidence as it is, fenced. */
export function renderEvidence(evidence: string): string {
  const issues = validationIssues(evidence);
  if (issues === undefined || issues.length === 0) return fence(evidence);
  return issues.map((issue) => `- ${issue.level} \`${issue.path}\`: ${issue.message}`).join("\n");
}

/** A design reviewer's findings, one line each: severity, location, summary. */
export function renderFindings(findings: readonly Finding[]): string {
  return findings.map((finding) => `- **${finding.severity}** \`${finding.location}\`: ${finding.summary}`).join("\n");
}

interface ValidationIssue {
  level: string;
  path: string;
  message: string;
}

function validationIssues(evidence: string): ValidationIssue[] | undefined {
  let report: unknown;
  try {
    report = JSON.parse(evidence);
  } catch {
    return undefined;
  }
  const items = (report as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  const issues: ValidationIssue[] = [];
  for (const item of items as { issues?: unknown }[]) {
    if (!Array.isArray(item.issues)) return undefined;
    for (const issue of item.issues as Partial<Record<keyof ValidationIssue, unknown>>[]) {
      if (typeof issue.message !== "string") return undefined;
      issues.push({
        level: typeof issue.level === "string" ? issue.level : "ERROR",
        path: typeof issue.path === "string" ? issue.path : "",
        message: issue.message,
      });
    }
  }
  return issues;
}

/** A backtick fence longer than any backtick run in the content, so the content cannot close it. */
export function fence(content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${content.replace(/\n+$/, "")}\n${ticks}`;
}
