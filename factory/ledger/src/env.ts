/**
 * The ledger's connection string. Locally it points at `pnpm db:up` (docker-compose.yml);
 * in CI at the Postgres service container. Unset is an error, never a silent default.
 */
export const DATABASE_URL_VAR = "FACTORY_DATABASE_URL";
export const LOCAL_DATABASE_URL = "postgres://factory:factory@localhost:54329/factory";

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env[DATABASE_URL_VAR];
  if (url === undefined || url.trim() === "") {
    throw new Error(
      `${DATABASE_URL_VAR} is not set. Start the local ledger with \`pnpm db:up\` and export ${DATABASE_URL_VAR}=${LOCAL_DATABASE_URL}`,
    );
  }
  return url;
}
