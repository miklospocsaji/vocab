import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../src/github-remote.ts";

describe("parseGitHubRemote", () => {
  it.each([
    "https://github.com/miklospocsaji/vocab.git",
    "https://github.com/miklospocsaji/vocab",
    "git@github.com:miklospocsaji/vocab.git",
    "ssh://git@github.com/miklospocsaji/vocab.git",
  ])("reads the owner and repository from %s", (url) => {
    expect(parseGitHubRemote(url)).toEqual({ owner: "miklospocsaji", repo: "vocab" });
  });

  it("rejects a remote that is not on GitHub, without echoing credentials", () => {
    expect(() => parseGitHubRemote("https://user:secret@gitlab.com/a/b.git")).toThrow(/not a GitHub repository/);
    expect(() => parseGitHubRemote("https://user:secret@gitlab.com/a/b.git")).not.toThrow(/secret/);
  });
});
