import { describe, expect, it } from "vitest";
import { keywordsIn } from "@omp-ui/core/magic-keywords";
import { gitResolutionPrompt, type GitResolutionTrigger } from "./git-resolution-prompt";

const diverged: GitResolutionTrigger = {
  kind: "diverged",
  branch: "feature/x",
  upstream: "origin/main",
  cwd: "/home/dev/checkout",
};

describe("gitResolutionPrompt", () => {
  it("names the checkout, branch, and upstream in the diverged arm", () => {
    const text = gitResolutionPrompt(diverged);
    expect(text).toContain("/home/dev/checkout");
    expect(text).toContain("feature/x");
    expect(text).toContain("origin/main");
    expect(text).toContain("git log --oneline origin/main..feature/x");
    expect(text).toContain("git merge-base feature/x origin/main");
  });

  it("ends the diverged arm with the never-push instruction and the fetch fallback", () => {
    const text = gitResolutionPrompt(diverged);
    expect(text).toContain("Do not push, publish, or open a pull request.");
    expect(text).toContain("If the remote cannot be fetched from this machine");
  });

  it("names the checkout and branch in the merge arm and never pushes", () => {
    const text = gitResolutionPrompt({ kind: "merge", branch: "main", cwd: "/repo/wt/a" });
    expect(text).toContain("/repo/wt/a");
    expect(text).toContain("main");
    expect(text).toContain("MERGE_HEAD");
    expect(text).toContain("Do not\n   push, publish, or open a pull request.");
  });

  it("the merge arm works without a branch name on a detached HEAD", () => {
    const text = gitResolutionPrompt({ kind: "merge", branch: null, cwd: "/repo" });
    expect(text).toContain("detached HEAD");
    expect(text).toContain("/repo");
  });

  it("a path or branch carrying a magic keyword arms nothing", () => {
    const carrying: GitResolutionTrigger[] = [
      { ...diverged, cwd: "/home/dev/ultrathink" },
      { ...diverged, branch: "orchestrate" },
      { ...diverged, upstream: "origin/workflowz" },
      { kind: "merge", branch: "jevify", cwd: "/repo" },
    ];
    for (const trigger of carrying) {
      expect([...keywordsIn(gitResolutionPrompt(trigger))]).toEqual([]);
    }
  });
});
