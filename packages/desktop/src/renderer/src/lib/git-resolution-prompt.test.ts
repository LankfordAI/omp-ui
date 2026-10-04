import { describe, expect, it } from "vitest";
import { keywordsIn } from "@omp-ui/core/magic-keywords";
import { gitResolutionPrompt, type GitResolutionTrigger } from "./git-resolution-prompt";

const diverged: GitResolutionTrigger = {
  kind: "diverged",
  branch: "feature/x",
  upstream: "origin/main",
  cwd: "/home/dev/checkout",
};

const finish: Extract<GitResolutionTrigger, { kind: "merge" }> = {
  kind: "merge",
  branch: "main",
  cwd: "/repo",
  finish: {
    sourceBranch: "feature/x",
    destinationBranch: "main",
    files: ["src/conflicted.ts"],
  },
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

  it("dynamic checkout, branch, and Finish observations carrying magic keywords arm nothing", () => {
    const carrying: GitResolutionTrigger[] = [
      { ...diverged, cwd: "/home/dev/ultrathink" },
      { ...diverged, branch: "orchestrate" },
      { ...diverged, upstream: "origin/workflowz" },
      { kind: "merge", branch: "jevify", cwd: "/repo" },
      { kind: "merge", branch: null, cwd: "/repo/ultrathink's checkout" },
      { ...finish, cwd: "/repo/workflowz", branch: "orchestrate" },
      {
        ...finish,
        finish: { sourceBranch: "ultrathink", destinationBranch: "main", files: [] },
      },
      {
        ...finish,
        finish: { sourceBranch: "feature/x", destinationBranch: "orchestrate", files: [] },
      },
      {
        ...finish,
        finish: {
          sourceBranch: "feature/x",
          destinationBranch: null,
          files: ["src/workflowz.ts", "jevify", "dir/ultrathink", "orchestrate"],
        },
      },
    ];
    for (const trigger of carrying) {
      expect([...keywordsIn(gitResolutionPrompt(trigger))]).toEqual([]);
    }
  });
});
