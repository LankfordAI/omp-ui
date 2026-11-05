import { describe, expect, it } from "vitest";
import {
  COUNCIL_AGENT,
  COUNCIL_ASK_PLAYBOOK,
  COUNCIL_COMMAND,
  COUNCIL_LAUNCH_TYPE,
  COUNCIL_REVIEW_PLAYBOOK,
  COUNCIL_TOOL,
  councilMemberSlug,
  councilNameFromModel,
  MAX_COUNCIL_NAME,
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

describe("councilNameFromModel", () => {
  it("names a nested model by its last path segment (#1056)", () => {
    expect(councilNameFromModel("openrouter/anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
  });

  it("matches councilMemberSlug for a flat id", () => {
    const id = "GPT 6 Sol";
    expect(councilNameFromModel(`openai/${id}`)).toBe(councilMemberSlug(id));
  });

  it("strips a thinking level before taking the segment", () => {
    expect(councilNameFromModel("litellm/Qwen3.8-Flash-Next:high")).toBe("qwen3-8-flash-next");
  });

  it("keeps a non-level colon tail (OpenRouter's :exacto-2)", () => {
    // parseModelRole only keeps a colon tail when it is not a bare level
    // word: digits disqualify "exacto-2", so the slug keeps the whole tail.
    expect(councilNameFromModel("openrouter/anthropic/gpt-4:exacto-2")).toBe("gpt-4-exacto-2");
    // A lowercase-only tail reads as a thinking level and is stripped.
    expect(councilNameFromModel("openrouter/anthropic/claude:exacto")).toBe("claude");
  });

  it("returns null when nothing launchable is named", () => {
    expect(councilNameFromModel(null)).toBe(null);
    expect(councilNameFromModel("   ")).toBe(null);
    // The last segment slugs to nothing.
    expect(councilNameFromModel("azure/🔒")).toBe(null);
  });

  it("slices an over-long tail to MAX_COUNCIL_NAME", () => {
    const name = councilNameFromModel(`provider/${"model".repeat(6)}`)!;
    expect(name).toBe("model".repeat(6).slice(0, MAX_COUNCIL_NAME));
    expect(name.length).toBe(MAX_COUNCIL_NAME);
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
