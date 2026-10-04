import { describe, expect, it } from "vitest";
import { CODE_REVIEW_COMMAND, CODE_REVIEW_TOOL, PR_TARGET_COMMANDS, REVIEW_PLAYBOOK } from "./review";

describe("wire constants", () => {
  it("namespace the tool but not the command", () => {
    expect(CODE_REVIEW_COMMAND).toBe("code-review");
    expect(CODE_REVIEW_TOOL).toBe("omp-ui_code_review");
  });
});

describe("reviewer playbook", () => {
  it("pins the drift reason to one string in both texts", () => {
    const drift = "review incomplete: PR head changed since target resolution";
    expect(REVIEW_PLAYBOOK).toContain(drift);
    expect(PR_TARGET_COMMANDS).toContain(drift);
  });

  it("owns the output contract in the playbook alone", () => {
    expect(REVIEW_PLAYBOOK).toContain("reply exactly:");
    expect(REVIEW_PLAYBOOK).toContain("no findings.");
    expect(REVIEW_PLAYBOOK).toContain("review incomplete:");
    expect(PR_TARGET_COMMANDS).not.toContain("no findings.");
  });
});
