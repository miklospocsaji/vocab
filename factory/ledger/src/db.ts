import type pg from "pg";

/** Anything the typed queries can run on: the pool, or one client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient | pg.Client;
