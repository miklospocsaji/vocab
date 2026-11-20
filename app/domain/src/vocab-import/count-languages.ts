import type { VocabImport } from "../../../contracts/src/index.ts";

export interface LanguageCount {
  language: string | null;
  count: number;
}

export function countLanguages(vocab: VocabImport): LanguageCount[] {
  const languageOf = new Map<string, string | null>();
  for (const word of vocab.words) languageOf.set(word.id, word.language);
  const counts = new Map<string | null, number>();
  for (const lookup of vocab.lookups) {
    const language = languageOf.get(lookup.wordId) ?? null;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts].map(([language, count]) => ({ language, count })).sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.language === b.language) return 0;
    if (a.language === null) return 1;
    if (b.language === null) return -1;
    return a.language < b.language ? -1 : 1;
  });
}
