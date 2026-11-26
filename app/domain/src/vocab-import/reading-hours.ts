import type { VocabImport } from "../../../contracts/src/index.ts";

export type HourCount = { hour: number; count: number };

export type LookupsPerHour = { hours: HourCount[]; undated: number };

export function lookupsPerHour(_imported: VocabImport): LookupsPerHour {
  throw new Error("not implemented");
}

export function peakReadingHours(_perHour: LookupsPerHour): number[] {
  throw new Error("not implemented");
}
