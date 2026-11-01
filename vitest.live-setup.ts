// Live tests authenticate with the owner's subscription token (ADR 0006), kept in the git-ignored .env.local.
process.loadEnvFile(new URL(".env.local", import.meta.url));
