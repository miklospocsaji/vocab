import type { Migration } from "../migrate.ts";

/**
 * Every migration, in the order they apply (ADR 0007). Append only: never edit, reorder or
 * remove one that has shipped. Each is a module exporting its SQL, so nothing is bundled
 * besides code. The first comes with the first feature that needs a table.
 */
export const migrations: readonly Migration[] = [];
