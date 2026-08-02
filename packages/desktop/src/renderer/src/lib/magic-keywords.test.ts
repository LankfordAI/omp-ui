import { describe, expect, it } from "vitest";
import { keywordColors, magicKeywordSegments } from "./magic-keywords";

/**
 * These cases are the contract that keeps the composer's glow honest: omp only
 * fires its magic-keyword notice for an occurrence that survives the same
 * boundary and prose-masking rules, so a divergence here paints a promise the
 * agent will not keep.
 */
describe("magicKeywordSegments", () => {
  /** Just the painted runs; the prose between them is covered by the round-trip case. */
  const kw = (text: string) => magicKeywordSegments(text).filter((s) => s.keyword !== null);

  it("matches the standalone lowercase word next to prose punctuation", () => {
    for (const input of [
      "orchestrate this",
      "orchestrate.",
      '"orchestrate"',
      "(orchestrate)",
      "orchestrate:",
    ]) {
      const found = kw(input);
      expect(found, input).toHaveLength(1);
      expect(found[0], input).toEqual({ text: "orchestrate", keyword: "orchestrate" });
    }
  });

  it("refuses an occurrence bound into an identifier, path, or call", () => {
    for (const input of [
      "Orchestrate this",
      "orchestrated",
      "preorchestrate",
      "orchestrate.ts",
      "orchestrate()",
      "src/orchestrate",
      "foo::orchestrate",
      "orchestrate-mode",
      "workflow",
    ]) {
      expect(kw(input), input).toHaveLength(0);
    }
  });

  it("never paints a keyword inside code or markup", () => {
    expect(kw("fix `orchestrate` now")).toHaveLength(0);
    expect(kw("```\norchestrate\n```")).toHaveLength(0);
    expect(kw("<x>orchestrate</x>")).toHaveLength(0);
  });

  it("treats an unmatched backtick run as literal text", () => {
    // An opening run that never closes is prose, not a code span, so omp fires
    // its notice there too and the composer has to agree.
    expect(kw("fix `orchestrate now")).toHaveLength(1);
  });

  it("finds all three keywords in one pass, in source order", () => {
    const input = "ultrathink then orchestrate then workflowz";
    expect(kw(input).map((s) => s.keyword)).toEqual(["ultrathink", "orchestrate", "workflowz"]);
  });

  it("returns no segments for an empty draft", () => {
    expect(magicKeywordSegments("")).toEqual([]);
  });

  it("returns one plain segment when nothing matches", () => {
    expect(magicKeywordSegments("plain text")).toEqual([{ text: "plain text", keyword: null }]);
  });

  it("rejoins to exactly the input", () => {
    const input = "go orchestrate it, then `orchestrate` again, then ultrathink.";
    const segments = magicKeywordSegments(input);
    expect(segments.map((s) => s.text).join("")).toBe(input);
    for (const segment of segments) expect(segment.text).not.toBe("");
  });
});

describe("keywordColors", () => {
  it("sweeps omp's teal-to-violet ramp across orchestrate", () => {
    const colors = keywordColors("orchestrate", 0);
    expect(colors).toHaveLength(11);
    expect(colors[0]).toBe("hsl(150 90% 62%)");
    expect(colors[10]).toBe("hsl(261 90% 62%)");
  });

  it("gives each keyword its own hue origin", () => {
    expect(keywordColors("ultrathink", 0)[0]).toBe("hsl(0 90% 62%)");
    expect(keywordColors("workflowz", 0)[0]).toBe("hsl(30 90% 62%)");
  });

  it("rotates the sample with the shimmer phase", () => {
    expect(keywordColors("orchestrate", 0.5)[0]).toBe("hsl(215 90% 62%)");
  });

  it("wraps a phase outside [0,1)", () => {
    expect(keywordColors("orchestrate", -0.5)).toEqual(keywordColors("orchestrate", 0.5));
    expect(keywordColors("orchestrate", 1)).toEqual(keywordColors("orchestrate", 0));
  });
});
