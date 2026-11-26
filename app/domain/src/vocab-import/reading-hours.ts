import type { VocabImport } from "../../../contracts/src/index.ts";

export type HourCount = { hour: number; count: number };

export type LookupsPerHour = { hours: HourCount[]; undated: number };

export function lookupsPerHour(imported: VocabImport): LookupsPerHour {
  const counts = new Array<number>(24).fill(0);
  let undated = 0;
  for (const lookup of imported.lookups) {
    if (lookup.timestamp === null) {
      undated += 1;
      continue;
    }
    const hour = new Date(lookup.timestamp).getUTCHours();
    counts[hour] = (counts[hour] ?? 0) + 1;
  }
  return { hours: counts.map((count, hour) => ({ hour, count })), undated };
}

export function peakReadingHours(perHour: LookupsPerHour): number[] {
  const max = Math.max(0, ...perHour.hours.map((h) => h.count));
  if (max === 0) return [];
  return perHour.hours.filter((h) => h.count === max).map((h) => h.hour);
}
