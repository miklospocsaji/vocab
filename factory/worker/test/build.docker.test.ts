/**
 * The build container: the `build` target of the worker Dockerfile (add-build-roles task 2.11).
 * Builds the target from a temp copy of this checkout, with a dummy `.env.local` and
 * `docs/vocab.db` added, then inspects it and installs a checkout offline from its warm store.
 * Needs Docker; runs only through `pnpm test:docker`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SECRET = `dummy-secret-${randomBytes(12).toString("hex")}`;
const VOCAB_DB = `dummy-vocab-db-${randomBytes(12).toString("hex")}`;
const IMAGE = `factory-build:test-${randomBytes(4).toString("hex")}`;

let context: string;
let archive: string;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Runs a shell command in a fresh container with no network and no added capabilities. */
function sh(script: string, ...mounts: string[]): string {
  return docker("run", "--rm", "--network", "none", ...mounts.flatMap((mount) => ["--volume", mount]), "--entrypoint", "sh", IMAGE, "-c", script);
}

beforeAll(() => {
  context = realpathSync(mkdtempSync(join(tmpdir(), "factory-build-image-")));
  cpSync(REPO_ROOT, context, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
  writeFileSync(join(context, ".env.local"), `CLAUDE_CODE_OAUTH_TOKEN=${SECRET}\n`);
  mkdirSync(join(context, "docs"), { recursive: true });
  writeFileSync(join(context, "docs/vocab.db"), VOCAB_DB);
  // What a build run clones: the tree the image was built from (a clone of master in the cloud),
  // as an archive the offline install test unpacks. Not HEAD: an uncommitted lockfile change
  // would make the install resolve, which it cannot do offline.
  archive = join(context, "checkout.tar");
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => file !== "" && file !== "docs/vocab.db" && !file.startsWith(".env"));
  execFileSync("tar", ["-cf", archive, "-T", "-"], { cwd: REPO_ROOT, input: files.join("\n") });

  docker("build", "--platform", "linux/amd64", "--file", join(context, "factory/worker/Dockerfile"), "--target", "build", "--tag", IMAGE, context);
});

afterAll(() => {
  spawnSync("docker", ["image", "rm", "--force", IMAGE], { stdio: "ignore" });
  rmSync(context, { recursive: true, force: true });
});

describe("factory-build image", () => {
  it("Scenario: Worker image holds no secrets (build target)", () => {
    const found = sh("find / -xdev \\( -name .env.local -o -name vocab.db -o -name .git \\) -print 2>/dev/null || true");
    expect(found).toBe("");
    const leaked = sh(`grep -rlsF -e '${SECRET}' -e '${VOCAB_DB}' / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev || true`);
    expect(leaked).toBe("");
    expect(docker("history", "--no-trunc", IMAGE)).not.toContain(SECRET);

    const user = docker("image", "inspect", "--format", "{{.Config.User}}", IMAGE);
    expect(user).not.toBe("");
    expect(["root", "0", "0:0"]).not.toContain(user);
    expect(sh("id -u")).not.toBe("0");
  });

  it("says it is the build container, and runs factory-build", () => {
    const env = JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Env}}", IMAGE)) as string[];
    expect(env).toContain("FACTORY_CONTAINER=build");
    expect(JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Entrypoint}}", IMAGE))).toEqual(["node", "/app/factory/worker/src/build-main.ts"]);
  });

  it("refuses a factory credential with exit 2, naming the variable and not its value", () => {
    const run = spawnSync("docker", ["run", "--rm", "--network", "none", "--env", `FACTORY_LEDGER_SECRET=${SECRET}`, IMAGE, "implementer", "--input", "work-items/x/input.json"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("FACTORY_LEDGER_SECRET");
    expect(`${run.stdout}${run.stderr}`).not.toContain(SECRET);
  });

  it("holds pnpm, git and the dev dependencies", () => {
    expect(sh("pnpm --version")).toMatch(/^12\.15\.0$/);
    expect(sh("git --version")).toMatch(/^git version /);
    expect(sh("cd /app && node_modules/.bin/vitest --version")).toContain("5.0.5");
  });

  it("installs a checkout offline from its warm store", () => {
    const started = performance.now();
    const output = sh(
      'mkdir -p "$HOME/work" && tar -x -C "$HOME/work" -f /checkout.tar && cd "$HOME/work" && pnpm install --frozen-lockfile --offline --store-dir "$FACTORY_PNPM_STORE" && test -x node_modules/.bin/vitest && echo installed',
      `${archive}:/checkout.tar:ro`,
    );
    const seconds = (performance.now() - started) / 1000;
    expect(output).toMatch(/installed$/);
    const bytes = Number(docker("image", "inspect", "--format", "{{.Size}}", IMAGE));
    // For tasks.md: the image size and the offline install time (container start included).
    console.info(`factory-build image: ${(bytes / 1e9).toFixed(2)} GB; offline install: ${seconds.toFixed(1)} s`);
  });
});
