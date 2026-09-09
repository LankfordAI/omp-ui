import { describe, expect, it } from "vitest";
import {
  baseBranchSegment,
  isMintedWorktreeBranch,
  remintWorktreeBranch,
  worktreeBranchPrefix,
} from "./worktree-branch";

describe("worktreeBranchPrefix (issue #438)", () => {
  it("names the project directory, not the app", () => {
    expect(worktreeBranchPrefix("/home/a/Repos/LankfordAI/omp-ui")).toBe("omp-ui");
    expect(worktreeBranchPrefix("/home/a/Repos/LankfordAI/FeatherNote")).toBe("feathernote");
    expect(worktreeBranchPrefix("/home/a/Repos/FeatherNote/")).toBe("feathernote");
  });

  it("reads a Windows path the same way under a posix Node", () => {
    expect(worktreeBranchPrefix("C:\\repos\\Feather Note")).toBe("feather-note");
  });

  it("falls back to 'project' when nothing usable names the directory", () => {
    expect(worktreeBranchPrefix("/")).toBe("project");
    expect(worktreeBranchPrefix("")).toBe("project");
  });

  it("caps an over-long basename at 32 chars", () => {
    expect(worktreeBranchPrefix(`/x/${"a".repeat(50)}`)).toBe("a".repeat(32));
  });
});

describe("baseBranchSegment", () => {
  it("prefers the new base, then the picked ref, then the active branch", () => {
    expect(baseBranchSegment("TECH-123", "main", "develop")).toBe("TECH-123");
    expect(baseBranchSegment(null, "main", "develop")).toBe("main");
    expect(baseBranchSegment(null, null, "develop")).toBe("develop");
  });

  it("falls through whitespace-only values and yields null when nothing names a branch", () => {
    expect(baseBranchSegment("  ", "  ", "develop")).toBe("develop");
    expect(baseBranchSegment(null, null, null)).toBeNull();
    expect(baseBranchSegment("", "  ", "")).toBeNull();
  });

  it("sanitises unsafe runs but preserves slashes and case", () => {
    expect(baseBranchSegment("release/2.0", null, null)).toBe("release/2.0");
    expect(baseBranchSegment("feat: two spaces~~", null, null)).toBe("feat-two-spaces");
    expect(baseBranchSegment("TECH-123", null, null)).toBe("TECH-123");
  });
});

describe("isMintedWorktreeBranch", () => {
  it("recognises this project's mints, with and without base segments", () => {
    expect(isMintedWorktreeBranch("p/f918c1d1", "p")).toBe(true);
    expect(isMintedWorktreeBranch("p/main/f918c1d1", "p")).toBe(true);
    expect(isMintedWorktreeBranch("p/release/2.0/f918c1d1", "p")).toBe(true);
  });

  it("rejects non-mints and another project's prefix", () => {
    expect(isMintedWorktreeBranch("p/deadBEEF", "p")).toBe(false);
    expect(isMintedWorktreeBranch("p/fix-login-bug", "p")).toBe(false);
    expect(isMintedWorktreeBranch("other/main/f918c1d1", "p")).toBe(false);
    expect(isMintedWorktreeBranch("f918c1d1", "p")).toBe(false);
  });
});

describe("remintWorktreeBranch", () => {
  it("follows the base while keeping the hash", () => {
    expect(remintWorktreeBranch("p/f918c1d1", "p", "TECH-123")).toBe("p/TECH-123/f918c1d1");
    expect(remintWorktreeBranch("p/old/f918c1d1", "p", "release/2.0")).toBe(
      "p/release/2.0/f918c1d1",
    );
    expect(remintWorktreeBranch("p/old/f918c1d1", "p", null)).toBe("p/f918c1d1");
  });

  it("never touches a hand-typed name or another project's mint", () => {
    expect(remintWorktreeBranch("feature/mine", "p", "TECH-123")).toBe("feature/mine");
    expect(remintWorktreeBranch("p/deadBEEF", "p", "TECH-123")).toBe("p/deadBEEF");
    expect(remintWorktreeBranch("other/main/f918c1d1", "p", "TECH-123")).toBe(
      "other/main/f918c1d1",
    );
  });
});
