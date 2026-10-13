import { describe, expect, it } from "vitest";
import { guidedGoalPrompt } from "@omp-ui/core/goal";
import { experimentInterviewPrompt } from "./experiment-kickoff";
import { splitInterviewDraft } from "./interview-draft";

describe("splitInterviewDraft", () => {
  it("splits a guided-goal kickoff into boilerplate and draft", () => {
    const draft = splitInterviewDraft(guidedGoalPrompt("speed up startup"));
    expect(draft).not.toBeNull();
    expect(draft!.draft).toBe("speed up startup");
    expect(draft!.captionKey).toBe("transcript.user.objectiveDraft");
    expect(draft!.preamble).not.toContain("objective-draft");
    expect(draft!.preamble).toContain("Interview the user");
  });

  it("splits an experiment interview kickoff with the description caption", () => {
    const draft = splitInterviewDraft(experimentInterviewPrompt("make tests faster"));
    expect(draft).not.toBeNull();
    expect(draft!.draft).toBe("make tests faster");
    expect(draft!.captionKey).toBe("transcript.user.roughDescription");
    expect(draft!.preamble).not.toContain("experiment-draft");
    expect(draft!.preamble).toContain("Set up an autoresearch experiment with me.");
  });

  it("returns null for the bare kickoffs, which carry no draft block", () => {
    expect(splitInterviewDraft(guidedGoalPrompt(""))).toBeNull();
    expect(splitInterviewDraft(experimentInterviewPrompt(""))).toBeNull();
  });

  it("returns null for a message merely containing the tag pair", () => {
    expect(splitInterviewDraft("see <objective-draft>x</objective-draft> for details")).toBeNull();
    expect(splitInterviewDraft("and <experiment-draft>y</experiment-draft> too")).toBeNull();
  });

  it("returns null when the head matches but the closing tag is missing", () => {
    const text = guidedGoalPrompt("speed up startup").replace(/\n<\/objective-draft>$/, "");
    expect(splitInterviewDraft(text)).toBeNull();
  });

  it("round-trips a draft containing fences and close-tag-looking lines", () => {
    // Only the final close tag delimits; everything before it is the body.
    const body = ["```", "code", "```", "</objective-draft>", "trailing"].join("\n");
    const draft = splitInterviewDraft(guidedGoalPrompt(body));
    expect(draft).not.toBeNull();
    expect(draft!.draft).toBe(body);
  });

  it("round-trips a draft that itself ends with the close tag", () => {
    // The close delimiter carries its newline, so the final delimiter is the
    // one the builder appended and the body slices out whole — the exact
    // boundary the builders trim otherwise makes unreachable.
    const draft = splitInterviewDraft(guidedGoalPrompt("</objective-draft>"));
    expect(draft).not.toBeNull();
    expect(draft!.draft).toBe("</objective-draft>");
  });
});
