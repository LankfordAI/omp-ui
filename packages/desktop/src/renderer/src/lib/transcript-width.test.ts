import { describe, expect, it } from "vitest";
import { columnCapFor, resolveTranscriptWidth } from "./transcript-width";

describe("transcript-width column caps (issue #1059)", () => {
  it("divides rem caps by the zoom scale so pane pixels land", () => {
    expect(columnCapFor(resolveTranscriptWidth("comfortable"), 1.25)).toBe("calc(56rem / 1.25)");
    expect(columnCapFor(resolveTranscriptWidth("wide"), 1)).toBe("calc(72rem / 1)");
    expect(columnCapFor(resolveTranscriptWidth("wide"), 1.5)).toBe("calc(72rem / 1.5)");
  });

  it("passes full's 100% through undivided at any scale", () => {
    // Percentages resolve against the parent layout box, which CSS zoom does
    // not scale — dividing "100%" would shrink the column instead of filling it.
    for (const scale of [1, 1.25, 1.5]) {
      expect(columnCapFor(resolveTranscriptWidth("full"), scale)).toBe("100%");
    }
  });

  it("falls back to wide for an unknown id", () => {
    const step = resolveTranscriptWidth("bogus");
    expect(step.id).toBe("wide");
    expect(step.transcriptMax).toBe("72rem");
  });
});
