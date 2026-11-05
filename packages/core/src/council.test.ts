import { describe, expect, it } from "vitest";
import {
  COUNCIL_AGENT,
  COUNCIL_ASK_PLAYBOOK,
  COUNCIL_COMMAND,
  COUNCIL_LAUNCH_TYPE,
  COUNCIL_REVIEW_PLAYBOOK,
  COUNCIL_TOOL,
  councilMemberSlug,
  PR_TARGET_COMMANDS,
} from "./council";

describe("wire constants", () => {
  it("namespace the tool, agent, and launch type but not the command", () => {
    expect(COUNCIL_COMMAND).toBe("council");
    expect(COUNCIL_TOOL).toBe("omp-ui_council");
    expect(COUNCIL_AGENT).toBe("omp-ui-council");
    expect(COUNCIL_LAUNCH_TYPE).toBe("omp-ui-council-launch");
  });
});

describe("councilMemberSlug", () => {
  it("lowercases and collapses every non-slug run into one hyphen", () => {
    expect(councilMemberSlug("Security Hawk")).toBe("security-hawk");
    expect(councilMemberSlug("GPT 6 / Sol!")).toBe("gpt-6-sol");
  });

  it("trims leading and trailing hyphens", () => {
    expect(councilMemberSlug("  --Opus--  ")).toBe("opus");
  });

  it("yields an empty slug for a name with no slug characters", () => {
    expect(councilMemberSlug("!!! ???")).toBe("");
  });
});

describe("review playbook", () => {
  it("pins the drift reason to one string in both texts", () => {
    const drift = "review incomplete: PR head changed since target resolution";
    expect(COUNCIL_REVIEW_PLAYBOOK).toContain(drift);
    expect(PR_TARGET_COMMANDS).toContain(drift);
  });

  it("owns the output contract, ending every reply with a score line", () => {
    expect(COUNCIL_REVIEW_PLAYBOOK).toContain('"no findings." on its own line');
    expect(COUNCIL_REVIEW_PLAYBOOK).toContain("review incomplete:");
    expect(COUNCIL_REVIEW_PLAYBOOK).toContain("SCORE: <0-10>/10");
    expect(COUNCIL_REVIEW_PLAYBOOK).toContain('"SCORE: none"');
    expect(PR_TARGET_COMMANDS).not.toContain("no findings.");
    expect(PR_TARGET_COMMANDS).not.toContain("SCORE:");
  });
});

describe("ask playbook", () => {
  it("asks for the four labelled output lines", () => {
    for (const label of ["POSITION:", "REASONING:", "RISKS:", "CONFIDENCE:"]) {
      expect(COUNCIL_ASK_PLAYBOOK).toContain(`\n${label} `);
    }
  });

  it("keeps members read-only", () => {
    expect(COUNCIL_ASK_PLAYBOOK).toContain("Read-only. Never edit or create files");
  });
});
