/**
 * The Forge contract: behaviour every Forge must show, run against GitHubForge (over an
 * emulated GitHub API) and FakeForge alike. `pushBranch` needs a git remote, so each
 * implementation tests it on its own.
 */
import { describe, expect, it } from "vitest";
import { ForgeError, type Forge } from "../src/index.ts";

export interface ContractIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
}

export interface ContractHarness {
  forge: Forge;
  defaultBranch: string;
  defaultSha: string;
  /** Seeds an issue on the forge's side. */
  addIssue(issue: ContractIssue): void;
  /** Seeds a branch head on the forge's side. */
  setBranch(branch: string, sha: string): void;
  /** The comments the forge holds for an issue, in order. */
  comments(issueNumber: number): string[];
  /** The branch head the forge holds, or undefined. */
  branchSha(branch: string): string | undefined;
}

const OTHER_SHA = "1111111111111111111111111111111111111111";

export function describeForgeContract(name: string, setup: () => ContractHarness): void {
  describe(`${name} meets the Forge contract`, () => {
    describe("getIssue", () => {
      it("returns the issue's number, title, body, state and URL", async () => {
        const h = setup();
        h.addIssue({ number: 12, title: "Import Kindle vocab.db", body: "Read the lookups from vocab.db.\n\n- keep the word", state: "open" });

        const issue = await h.forge.getIssue(12);

        expect(issue).toEqual({
          number: 12,
          title: "Import Kindle vocab.db",
          body: "Read the lookups from vocab.db.\n\n- keep the word",
          state: "open",
          url: expect.stringMatching(/\S/) as unknown,
        });
      });

      it("gives an issue without a body the empty string", async () => {
        const h = setup();
        h.addIssue({ number: 3, title: "Untitled thought", body: null, state: "open" });

        expect((await h.forge.getIssue(3)).body).toBe("");
      });

      it("reports a closed issue as closed", async () => {
        const h = setup();
        h.addIssue({ number: 4, title: "Done already", body: "x", state: "closed" });

        expect((await h.forge.getIssue(4)).state).toBe("closed");
      });

      it("rejects a missing issue with a not-found ForgeError", async () => {
        const h = setup();

        const error = await h.forge.getIssue(404).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ForgeError);
        expect(error).toMatchObject({ kind: "not-found" });
      });
    });

    describe("comment", () => {
      it("posts the body verbatim, in order", async () => {
        const h = setup();
        h.addIssue({ number: 12, title: "Import Kindle vocab.db", body: "x", state: "open" });
        const summary = "## Proposal: `add-import-kindle-vocab-db`\n\n- complexity: medium\n";

        await h.forge.comment(12, summary);
        await h.forge.comment(12, "second");

        expect(h.comments(12)).toEqual([summary, "second"]);
      });

      it("rejects a comment on a missing issue with a not-found ForgeError", async () => {
        const h = setup();

        const error = await h.forge.comment(404, "hello").catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ForgeError);
        expect(error).toMatchObject({ kind: "not-found" });
        expect(h.comments(404)).toEqual([]);
      });
    });

    describe("branchExists", () => {
      it("is true for the default branch and a pushed branch, false otherwise", async () => {
        const h = setup();
        h.setBranch("fix-something", OTHER_SHA);

        expect(await h.forge.branchExists(h.defaultBranch)).toBe(true);
        expect(await h.forge.branchExists("fix-something")).toBe(true);
        expect(await h.forge.branchExists("add-import-kindle-vocab-db")).toBe(false);
      });
    });

    describe("createBranch", () => {
      it("creates the branch at the default branch's head", async () => {
        const h = setup();

        const result = await h.forge.createBranch("add-import-kindle-vocab-db");

        expect(result).toEqual({ created: true, sha: h.defaultSha });
        expect(h.branchSha("add-import-kindle-vocab-db")).toBe(h.defaultSha);
        expect(await h.forge.branchExists("add-import-kindle-vocab-db")).toBe(true);
        expect(h.branchSha(h.defaultBranch)).toBe(h.defaultSha);
      });

      it("is a no-op if the branch exists, leaving its head where it is", async () => {
        const h = setup();
        h.setBranch("add-import-kindle-vocab-db", OTHER_SHA);

        const result = await h.forge.createBranch("add-import-kindle-vocab-db");

        expect(result).toEqual({ created: false, sha: OTHER_SHA });
        expect(h.branchSha("add-import-kindle-vocab-db")).toBe(OTHER_SHA);
      });

      it("is a no-op the second time it is called for a branch", async () => {
        const h = setup();

        await h.forge.createBranch("add-import-kindle-vocab-db");
        const again = await h.forge.createBranch("add-import-kindle-vocab-db");

        expect(again).toEqual({ created: false, sha: h.defaultSha });
      });
    });
  });
}
