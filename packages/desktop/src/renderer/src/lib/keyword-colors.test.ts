import { describe, expect, it } from "vitest";
import { keywordColors, keywordPalette } from "./keyword-colors";

/**
 * The colour contract: every ramp must sample omp's own hue endpoints (the
 * MAGIC_KEYWORDS table in @omp-ui/core/magic-keywords) — matching itself is
 * tested there.
 */
describe("keywordColors", () => {
  it("sweeps omp's teal-to-violet ramp across orchestrate", () => {
    const colors = keywordColors("orchestrate", 0);
    expect(colors).toHaveLength(11);
    expect(colors[0]).toBe("hsl(150 90% 62%)");
    expect(colors[10]).toBe("hsl(268 90% 62%)");
  });

  it("gives each keyword its own hue origin", () => {
    expect(keywordColors("ultrathink", 0)[0]).toBe("hsl(0 90% 62%)");
    expect(keywordColors("workflowz", 0)[0]).toBe("hsl(30 90% 62%)");
    expect(keywordColors("jevify", 0)[0]).toBe("hsl(300 90% 62%)");
  });

  it("wraps jevify's ramp past 360", () => {
    // omp's jevify ramp runs 300 → 420; 420 mod 360 is 60, and the sample at
    // t = 0.5 lands exactly on the wrap point.
    expect(keywordColors("jevify", 0.5)[0]).toBe("hsl(0 90% 62%)");
  });

  it("rotates the sample with the shimmer phase", () => {
    expect(keywordColors("orchestrate", 0.5)[0]).toBe("hsl(215 90% 62%)");
  });

  it("advances the colour on every small phase step instead of holding a stop", () => {
    // 0.02 of ultrathink's 330-degree ramp is 6.6 degrees: a visible step, not
    // a stall — the old 14-stop quantization returned hsl(0…) here (issue #204).
    expect(keywordColors("ultrathink", 0.02)[0]).toBe("hsl(7 90% 62%)");
    // Equal phase deltas move equal hue deltas: the sweep speed is uniform.
    expect(keywordColors("ultrathink", 0.1)[0]).toBe("hsl(33 90% 62%)");
    expect(keywordColors("ultrathink", 0.2)[0]).toBe("hsl(66 90% 62%)");
  });

  it("wraps a phase outside [0,1)", () => {
    expect(keywordColors("orchestrate", -0.5)).toEqual(keywordColors("orchestrate", 0.5));
    expect(keywordColors("orchestrate", 1)).toEqual(keywordColors("orchestrate", 0));
  });
});

describe("keywordPalette", () => {
  it("returns the 14-stop ring each keyword's colours sample", () => {
    for (const kw of ["ultrathink", "orchestrate", "workflowz", "jevify"] as const) {
      const palette = keywordPalette(kw);
      expect(palette).toHaveLength(14);
      expect(palette[0]).toBe(keywordColors(kw, 0)[0]);
    }
    expect(keywordPalette("orchestrate")[0]).toBe("hsl(150 90% 62%)");
  });
});
