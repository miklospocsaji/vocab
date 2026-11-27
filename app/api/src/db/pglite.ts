import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Db, Row, Scalar } from "./db.ts";

// The test adapter (ADR 0007): real Postgres SQL on an in-memory PGlite. PGlite is a dev
// dependency, and this file imports only its types, so it never reaches a Lambda bundle.

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;

/**
 * Turns `:name` parameters into Postgres's `$n`. A repeated name keeps its position. Casts
 * (`::type`), single-quoted strings, double-quoted identifiers and `--` comments are left
 * alone. A name with no value in `params` is rejected.
 */
export function toPositional(
  sql: string,
  params: Record<string, Scalar> | undefined,
): { sql: string; values: Scalar[] } {
  const positions = new Map<string, number>();
  const values: Scalar[] = [];
  let out = "";
  let i = 0;
  const copyTo = (end: number): void => {
    out += sql.slice(i, end);
    i = end;
  };
  while (i < sql.length) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (c === "'" || c === '"') {
      // A doubled quote is an escaped one: it closes and reopens, so scanning on stays right.
      const close = sql.indexOf(c, i + 1);
      copyTo(close === -1 ? sql.length : close + 1);
    } else if (c === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      copyTo(eol === -1 ? sql.length : eol);
    } else if (c === ":" && next === ":") {
      copyTo(i + 2);
    } else if (c === ":" && NAME_START.test(next)) {
      let end = i + 2;
      while (end < sql.length && NAME_PART.test(sql.charAt(end))) end++;
      const name = sql.slice(i + 1, end);
      let position = positions.get(name);
      if (position === undefined) {
        if (params === undefined || !Object.hasOwn(params, name)) throw new Error(`No value for the parameter :${name}`);
        values.push(params[name] ?? null);
        position = values.length;
        positions.set(name, position);
      }
      out += `$${String(position)}`;
      i = end;
    } else {
      copyTo(i + 1);
    }
  }
  return { sql: out, values };
}

/** Opens a transaction for `work`, or joins the one already open. */
type Opener = <R>(work: (tx: Transaction) => Promise<R>) => Promise<R>;

function wrap(pg: PGlite | Transaction, open: Opener): Db {
  const db: Db = {
    async query<T extends Row = Row>(sql: string, params?: Record<string, Scalar>): Promise<T[]> {
      const positional = toPositional(sql, params);
      const result = await pg.query<T>(positional.sql, positional.values);
      return result.rows;
    },
    transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
      return open((tx) => work(wrap(tx, (inner) => inner(tx))));
    },
  };
  return db;
}

/** A `Db` over an open PGlite. A transaction inside a transaction joins it. */
export function createPgliteDb(pglite: PGlite): Db {
  return wrap(pglite, (work) => pglite.transaction(work));
}
