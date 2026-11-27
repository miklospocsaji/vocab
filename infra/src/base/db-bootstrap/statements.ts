// The database bootstrap's SQL (ADR 0007), kept pure so it is tested, also on PGlite. It runs
// as the cluster's master user, in the `postgres` database.
//
// Postgres takes no bound parameter in `CREATE ROLE … PASSWORD`, so each password goes into
// the statement as a literal. It is checked first: 32 letters and digits, which the
// environment secrets' `excludePunctuation` guarantees. Names are checked as plain
// identifiers. Nothing else reaches the SQL.

const PASSWORD = /^[A-Za-z0-9]{32}$/;
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The statements for one environment: its role and its database, both called `name`. */
export interface BootstrapStep {
  readonly name: string;
  /** Creates the role when missing and aligns it otherwise, with the secret's password. */
  readonly role: string;
  /** Lets the master user act as the role, which Postgres 16+ needs to give it a database. */
  readonly membership: string;
  /** Returns a row when the database exists. */
  readonly exists: string;
  /** Runs only when `exists` returned no row; cannot run in a transaction. */
  readonly createDatabase: string;
  readonly secure: readonly string[];
}

export function bootstrapStatements(
  names: readonly string[],
  passwords: Readonly<Record<string, string | undefined>>,
): BootstrapStep[] {
  return names.map((name) => {
    if (!NAME.test(name)) throw new Error(`Refusing the database name ${JSON.stringify(name)}: not a plain identifier`);
    const password = passwords[name];
    // The message never carries the password.
    if (password === undefined || !PASSWORD.test(password))
      throw new Error(`Refusing the password for ${name}: it must be 32 letters and digits`);
    const attributes = `LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`;
    return {
      name,
      role: [
        "DO $$ BEGIN",
        "PERFORM set_config('password_encryption', 'scram-sha-256', true);",
        `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}') THEN`,
        `CREATE ROLE ${name} ${attributes};`,
        "ELSE",
        `ALTER ROLE ${name} WITH ${attributes};`,
        "END IF;",
        "END $$",
      ].join(" "),
      membership: `GRANT ${name} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`,
      exists: `SELECT datname FROM pg_database WHERE datname = '${name}'`,
      createDatabase: `CREATE DATABASE ${name} OWNER ${name}`,
      secure: [`ALTER DATABASE ${name} OWNER TO ${name}`, `REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`],
    };
  });
}

/** Runs one statement and returns its rows. `label` names the step without any SQL. */
export type Execute = (sql: string, label: string) => Promise<readonly unknown[]>;

/** Applies the plan, one statement at a time, creating only the databases that are missing. */
export async function runBootstrap(plan: readonly BootstrapStep[], execute: Execute): Promise<void> {
  for (const step of plan) {
    await execute(step.role, `role ${step.name}`);
    await execute(step.membership, `membership of ${step.name}`);
    const existing = await execute(step.exists, `lookup of database ${step.name}`);
    if (existing.length === 0) await execute(step.createDatabase, `database ${step.name}`);
    for (const statement of step.secure) await execute(statement, `privileges of database ${step.name}`);
  }
}
