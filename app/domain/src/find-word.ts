export type WordRange = { start: number; end: number };

export function findWord(sentence: string, word: string): WordRange | undefined {
  if (word.trim() === "") return undefined;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
  const match = pattern.exec(sentence);
  if (!match) return undefined;
  return { start: match.index, end: match.index + match[0].length };
}
