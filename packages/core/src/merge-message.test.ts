import { describe, expect, it } from "vitest";
import { buildMergeMessage } from "./merge-message";

const BR = "omp-ui/deadbeef";

/** The two fields every case names, so each test reads as input → message. */
function build(messages: readonly string[]): { subject: string; body: string } {
  return buildMergeMessage({ branch: BR, destination: "main", messages });
}

describe("buildMergeMessage", () => {
  it("names both refs with an empty body when nothing was folded", () => {
    expect(build([])).toEqual({ subject: `Merge ${BR} into main`, body: "" });
  });

  it("contributes no subject for a whitespace-only message", () => {
    expect(build(["  \n\n \t\n"])).toEqual({ subject: `Merge ${BR} into main`, body: "" });
  });

  it("borrows a lone commit's subject and lists no bullets", () => {
    expect(build(["fix: only change\n\nsome body\n"])).toEqual({
      subject: `Merge ${BR}: fix: only change`,
      body: "",
    });
  });

  it("still emits closing refs for a lone commit", () => {
    expect(build(["fix: thing\n\nCloses #12\n"])).toEqual({
      subject: `Merge ${BR}: fix: thing`,
      body: "Fixes #12",
    });
  });

  it("counts several commits and lists their subjects oldest first", () => {
    expect(build(["one\n", "two\n\nbody\n", "three\n"])).toEqual({
      subject: `Merge ${BR} into main (3 commits)`,
      body: "- one\n- two\n- three",
    });
  });

  it("dedupes a reference repeated across commits", () => {
    expect(build(["a\n\nFixes #7\n", "b\n\ncloses #7\n"]).body).toBe("- a\n- b\n\nFixes #7");
  });

  it("keeps distinct references in first-seen order", () => {
    expect(build(["a\n\nFixes #9\n", "b\n\nResolves #4\n"]).body).toBe(
      "- a\n- b\n\nFixes #9\nFixes #4",
    );
  });

  it("recognizes cross-repo, GH- and colon-separated reference shapes", () => {
    expect(
      build(["a\n\nfixed owner/repo#9\n", "b\n\nclose GH-4\n", "c\n\nResolved: #5\n"]).body,
    ).toBe("- a\n- b\n- c\n\nFixes owner/repo#9\nFixes GH-4\nFixes #5");
  });

  it("does not treat a bare reference as a closing reference", () => {
    expect(build(["a\n\nsee #3 for context\n", "b\n"]).body).toBe("- a\n- b");
  });

  it("caps the bullet list at 20 with a counted tail", () => {
    const messages = Array.from({ length: 22 }, (_, i) => `subject ${i + 1}\n`);
    const { subject, body } = build(messages);
    expect(subject).toBe(`Merge ${BR} into main (22 commits)`);
    const lines = body.split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe("- subject 1");
    expect(lines[19]).toBe("- subject 20");
    expect(lines[20]).toBe("- ... and 2 more");
  });

  it("clips a borrowed subject to 200 characters", () => {
    const { subject } = build([`${"x".repeat(300)}\n`]);
    expect(subject.length).toBeLessThanOrEqual(200);
    expect(subject.startsWith(`Merge ${BR}: xxx`)).toBe(true);
    expect(subject.endsWith("...")).toBe(true);
  });

  it("clips a long bullet to 100 characters", () => {
    const long = "y".repeat(160);
    const bullet = build([`${long}\n`, "short\n"]).body.split("\n")[0];
    // "- " plus the clipped subject.
    expect(bullet).toHaveLength(102);
    expect(bullet.endsWith("...")).toBe(true);
  });
});
