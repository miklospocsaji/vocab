import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Runs a command and resolves with its stdout. */
export type RunCommand = (command: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultRun: RunCommand = async (command, args) => (await execFileAsync(command, args, { encoding: "utf8" })).stdout;

const LOGIN_HINT = "log in with `gh auth login`, then run the factory again";

/**
 * The owner's GitHub token from `gh auth token`, read once at CLI start-up. Rejects with
 * instructions when gh is missing or logged out. The token is never logged, and gh's
 * output never goes into an error message.
 */
export async function ghAuthToken(run: RunCommand = defaultRun): Promise<string> {
  let stdout: string;
  try {
    stdout = await run("gh", ["auth", "token"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
    // No `cause`: the child-process error carries gh's stdout, which is where a token would be.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`cannot read a GitHub token with \`gh auth token\` (${reason ?? "unknown error"}); ${LOGIN_HINT}`);
  }
  const token = stdout.trim();
  if (token === "") throw new Error(`\`gh auth token\` printed no token; ${LOGIN_HINT}`);
  return token;
}
