/** Leading words kept as the change id's verb; any other title gets `add`. */
export const CHANGE_ID_VERBS = ["add", "fix", "change", "remove", "improve", "refactor"] as const;

/** The longest change id, collision suffix included. */
export const CHANGE_ID_MAX_LENGTH = 40;

/** Whether an id is already used, in the ledger or as a remote branch. */
export type IsTaken = (id: string) => boolean | Promise<boolean>;

const VERBS: ReadonlySet<string> = new Set(CHANGE_ID_VERBS);

/**
 * The change id for an issue title: `<verb>-<slug>`, lower-case kebab-case, at most 40
 * characters cut at a word boundary. A taken id gets a `-2`, `-3`, … suffix, which counts
 * toward the 40 characters, so the base is cut shorter to make room.
 */
export async function deriveChangeId(title: string, isTaken: IsTaken): Promise<string> {
  const words = kebabWords(title);
  const verb = words[0] !== undefined && VERBS.has(words[0]) ? words.shift() ?? "add" : "add";
  const full = [verb, ...words].join("-");

  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${String(n)}`;
    const candidate = fit(full, verb.length, CHANGE_ID_MAX_LENGTH - suffix.length) + suffix;
    if (!(await isTaken(candidate))) return candidate;
  }
}

/** The title's words, accents stripped, with every run of other characters as a separator. */
function kebabWords(title: string): string[] {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

/**
 * Cuts `id` to `max` characters at the last word boundary. If that would leave only the
 * verb, the first word after it is cut hard instead.
 */
function fit(id: string, verbLength: number, max: number): string {
  if (id.length <= max || id[max] === "-") return id.slice(0, max);
  const cut = id.slice(0, max);
  const boundary = cut.lastIndexOf("-");
  return boundary > verbLength ? cut.slice(0, boundary) : cut;
}
