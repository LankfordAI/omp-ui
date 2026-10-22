import { describe, expect, it } from "vitest";
import { identityWash, monogramColors, monogramColorsForHue, projectHue } from "./project-colors";

/**
 * The colour contract (ADR-0004 exception): a hue per identity seed, and an
 * AA-safe monogram fill for every one of the 360 hues it can land on.
 */

/** Local hsl() parse — the test must not trust the module's own conversion. */
function parseHsl(css: string): [number, number, number] {
  const m = /^hsl\((\d+) 60% (\d+)%\)$/.exec(css);
  if (!m) throw new Error(`unparseable fill: ${css}`);
  const h = Number(m[1]);
  const sn = 0.6; // saturation is a literal in the regex above
  const ln = Number(m[2]) / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const luminance = ([r, g, b]: [number, number, number]): number => {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.072 * lin(b);
};

const INK: [number, number, number] = [0xf7, 0xf9, 0xfb];

describe("projectHue", () => {
  const seeds = [
    "repo:github.com/LankfordAI/omp-ui",
    "local\u0000/home/x/proj",
    "local\u0000/home/alankford/code/radiance",
    "repo:github.com/example/tiny",
  ];

  it("is deterministic and lands inside [0, 360)", () => {
    for (const seed of seeds) {
      const hue = projectHue(seed);
      expect(projectHue(seed)).toBe(hue);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("separates distinct identities", () => {
    // Hashing doesn't guarantee distinctness, but these concrete seeds must
    // not collide — the whole feature rests on adjacent projects looking apart.
    expect(projectHue(seeds[0])).not.toBe(projectHue(seeds[1]));
    expect(projectHue(seeds[2])).not.toBe(projectHue(seeds[3]));
  });
});

describe("monogramColorsForHue", () => {
  // The load-bearing sweep: the fixed-ink scheme is only justified if EVERY
  // hue on the wheel clears AA against the ink — one formula, no exceptions.
  it("clears WCAG AA against the near-white ink for every hue", () => {
    for (let hue = 0; hue < 360; hue++) {
      const colors = monogramColorsForHue(hue);
      expect(colors.color).toBe("#f7f9fb");
      const [hi, lo] = [luminance(parseHsl(colors.backgroundColor)), luminance(INK)].sort(
        (a, b) => b - a,
      );
      const ratio = (hi + 0.05) / (lo + 0.05);
      expect(ratio, `hue ${hue} → ${colors.backgroundColor}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("monogramColors is just hue-then-fill", () => {
    const seed = "repo:github.com/LankfordAI/omp-ui";
    expect(monogramColors(seed)).toEqual(monogramColorsForHue(projectHue(seed)));
  });
});

describe("identityWash", () => {
  it("pins the wash to the seed's hue at fixed alpha", () => {
    const seed = "repo:github.com/LankfordAI/omp-ui";
    const hue = projectHue(seed);
    expect(identityWash(seed)).toEqual({
      backgroundColor: `hsl(${hue} 60% 55% / 0.22)`,
      borderColor: `hsl(${hue} 60% 55% / 0.45)`,
    });
  });
});
