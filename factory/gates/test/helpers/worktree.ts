import { chmod, cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const fixtures = resolve(import.meta.dirname, "../fixtures");
const repoRoot = resolve(import.meta.dirname, "../../../..");

/** The repository's pinned tools that a fixture worktree runs. */
const packages = ["vitest", "typescript", "eslint", "typescript-eslint", "globals", "@types/node", "@eslint/js", "@fission-ai/openspec"];
const bins = ["tsc", "eslint", "vitest", "openspec"];

/**
 * Copies `fixtures/workspace` and then each overlay into a new temporary directory, and links the
 * repository's pinned tools into a real `node_modules` there. A symlink to the repository's own
 * `node_modules` would let pnpm treat the copy as installed and prune the repository's packages.
 * Files under an overlay's `probe-bin/` replace the tools of the same name in `node_modules/.bin`.
 */
export async function makeWorktree(...overlays: string[]): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), "gates-worktree-"));
  for (const source of ["workspace", ...overlays]) {
    await cp(join(fixtures, source), worktree, { recursive: true });
  }
  await mkdir(join(worktree, "node_modules", ".bin"), { recursive: true });
  for (const name of packages) {
    const link = join(worktree, "node_modules", name);
    await mkdir(resolve(link, ".."), { recursive: true });
    await symlink(join(repoRoot, "node_modules", name), link);
  }
  for (const name of bins) {
    await symlink(join(repoRoot, "node_modules", ".bin", name), join(worktree, "node_modules", ".bin", name));
  }
  const probes = join(worktree, "probe-bin");
  const probeNames = await readdir(probes).catch(() => []);
  for (const name of probeNames) {
    const bin = join(worktree, "node_modules", ".bin", name);
    await rm(bin, { force: true });
    await cp(join(probes, name), bin);
    await chmod(bin, 0o755);
  }
  return worktree;
}

export async function removeWorktree(worktree: string): Promise<void> {
  await rm(worktree, { recursive: true, force: true });
}
