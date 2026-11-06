import { existsSync } from "node:fs";

// Live tests authenticate with the owner's subscription token (ADR 0006), kept in the git-ignored .env.local.
// In the boundary-check image there is none: the task runs in api-key mode with the key from ECS.
const envFile = new URL(".env.local", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
