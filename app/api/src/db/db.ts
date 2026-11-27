// The database access every handler talks to (ADR 0007). SQL is written by hand with named
// parameters (`:name`), as the Data API takes them.

export type Scalar = string | number | boolean | null;
export type Row = Record<string, Scalar>;

export interface Db {
  /** Runs one statement and returns its rows (none for a statement without a result). */
  query<T extends Row = Row>(sql: string, params?: Record<string, Scalar>): Promise<T[]>;
  /**
   * Runs `work` in a transaction: commits when it resolves, rolls back when it throws.
   * Calling `transaction` on the `tx` it is given joins the same transaction.
   */
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
}
