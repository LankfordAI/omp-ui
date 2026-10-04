import { describe, expect, it } from "vitest";
import {
  CODE_REVIEW_COMMAND,
  CODE_REVIEW_TOOL,
  COMMIT_TARGET_COMMANDS,
  PR_TARGET_COMMANDS,
  REVIEW_PLAYBOOK,
  parseReviewArgs,
  targetBlock,
} from "./review";

describe("wire constants", () => {
  it("namespace the tool but not the command", () => {
    expect(CODE_REVIEW_COMMAND).toBe("code-review");
    expect(CODE_REVIEW_TOOL).toBe("omp-ui_code_review");
  });
});

describe("parseReviewArgs", () => {
  it("bare args review local changes", () => {
    expect(parseReviewArgs("")).toEqual({ target: { kind: "local", value: null, degraded: false } });
    expect(parseReviewArgs("   ")).toEqual({ target: { kind: "local", value: null, degraded: false } });
  });

  it("classifies pr, sha, range, and name targets", () => {
    expect(parseReviewArgs("pr 42")).toEqual({ target: { kind: "pr", value: "42", degraded: false } });
    expect(parseReviewArgs("deadbeef1234567")).toEqual({
      target: { kind: "commit", value: "deadbeef1234567", degraded: false },
    });
    expect(parseReviewArgs("abc1234..def5678")).toEqual({
      target: { kind: "commit", value: "abc1234..def5678", degraded: false },
    });
    expect(parseReviewArgs("HEAD~1")).toEqual({ target: { kind: "commit", value: "HEAD~1", degraded: false } });
    expect(parseReviewArgs("origin/main")).toEqual({
      target: { kind: "commit", value: "origin/main", degraded: false },
    });
  });

  it("rejects anything else with usage", () => {
    const usage = (args: string): string | undefined => {
      const parsed = parseReviewArgs(args);
      return "usage" in parsed ? parsed.usage : undefined;
    };
    expect(usage("pr")).toMatch(/pr <number>/);
    for (const bad of ["pr 0", "pr -3", "a b", "$(rm -rf /)", "main; touch /tmp/pwn", "a\nb"]) {
      expect(usage(bad)).toBeDefined();
    }
  });

  it("keeps args out of any shell shape a reviewer could stumble into", () => {
    // Backtick/quoting metacharacters must never reach a target value.
    for (const bad of ["`x`", "a|b", "a&&b", "a>b", "-x", "--x", "a b", "..", ".", "..x"]) {
      const parsed = parseReviewArgs(bad);
      if ("target" in parsed) {
        expect(parsed.target.value).toMatch(/^[A-Za-z0-9._/@^{}~/-]+$/);
      }
    }
  });
});

describe("target blocks", () => {
  it("local names merge-base commands and degrades on request", () => {
    expect(targetBlock({ kind: "local", value: null, degraded: false })).toMatch(/git merge-base HEAD <base>/);
    expect(targetBlock({ kind: "local", value: null, degraded: false })).toMatch(/git status --porcelain/);
    expect(targetBlock({ kind: "local", value: null, degraded: true })).toMatch(/git diff HEAD~1\.\.HEAD/);
    expect(targetBlock({ kind: "local", value: null, degraded: true })).toMatch(/no usable merge-base/);
  });

  it("commit and range commands verify refs and fill the token", () => {
    expect(targetBlock({ kind: "commit", value: "deadbeef", degraded: false })).toMatch(
      /git show --format=fuller deadbeef/,
    );
    expect(targetBlock({ kind: "commit", value: "deadbeef", degraded: false })).toMatch(/git rev-parse --verify/);
    expect(targetBlock({ kind: "commit", value: "a123456..b234567", degraded: false })).toMatch(
      /git diff a123456\.\.b234567\.\.\./,
    );
    expect(targetBlock({ kind: "commit", value: "a123456..b234567", degraded: false })).toMatch(
      /git log --oneline a123456\.\.b234567/,
    );
    expect(COMMIT_TARGET_COMMANDS).toContain("@@VALUE@@");
    expect(targetBlock({ kind: "commit", value: "x1234567", degraded: false })).not.toContain("@@VALUE@@");
  });

  it("pr commands stay read-only", () => {
    const block = targetBlock({ kind: "pr", value: "42", degraded: false });
    expect(block).toMatch(/gh pr diff 42/);
    expect(block).toMatch(/gh pr view 42/);
    expect(block).toMatch(/Never post/);
    expect(PR_TARGET_COMMANDS).toContain("@@VALUE@@");
    expect(targetBlock({ kind: "pr", value: "7", degraded: false })).toMatch(/pull request #7/);
  });
});

describe("playbook", () => {
  it("pins role, silence, and the findings grammar", () => {
    expect(REVIEW_PLAYBOOK).toMatch(/one of N independent code reviewers/);
    expect(REVIEW_PLAYBOOK).toMatch(/never post to any external service/);
    expect(REVIEW_PLAYBOOK).toMatch(/SEVERITY\(blocker\|major\|minor\|nit\) FILE:<path>:<line>/);
    expect(REVIEW_PLAYBOOK).toMatch(/reply exactly: no findings/);
  });
});
