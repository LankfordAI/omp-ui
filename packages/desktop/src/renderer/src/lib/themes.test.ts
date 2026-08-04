// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { THEMES, type Theme } from "./themes";

/**
 * The contrast gate (issue #36).
 *
 * A theme is authored by hand, so the failure mode is not "it looks wrong" —
 * it is "one slot in one theme is unreadable and nobody opens that theme for
 * a month". These are ratios, not taste: every assertion below is WCAG 2.x
 * relative luminance, computed here rather than imported so the gate has no
 * dependency that could go stale.
 */

/** WCAG relative luminance; `#rrggbbaa` is truncated to its opaque channels. */
function luminance(hex: string): number {
  const h = hex.replace("#", "").slice(0, 6);
  const channel = (offset: number): number => {
    const c = parseInt(h.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Names the pair in the failure message — a bare ratio says nothing. The
 * finiteness check is not paranoia: a typo'd hex parses to NaN, and NaN on
 * both sides of the comparison would let the slot through unmeasured.
 */
function expectContrast(theme: Theme, label: string, fg: string, bg: string, min: number): void {
  const ratio = contrast(fg, bg);
  expect(`${theme.id} ${label} ${fg} on ${bg}`, "unparseable colour").toSatisfy(() =>
    Number.isFinite(ratio),
  );
  expect(`${theme.id} ${label} ${ratio.toFixed(2)}:1`).toBe(
    `${theme.id} ${label} ${Math.max(ratio, min).toFixed(2)}:1`,
  );
}

/**
 * Ink tiers descend on purpose: `ink` is reading content, `ink-faint` is
 * de-emphasis (timestamps, disabled affordances) that must be *visible*, not
 * legible at length. Each tier gets the floor its job needs.
 */
const INK_TIERS: ReadonlyArray<[string, number]> = [
  ["--color-ink", 10],
  ["--color-ink-mid", 4.5],
  ["--color-ink-dim", 3],
  ["--color-ink-faint", 2],
];

const ACCENTS = ["signal", "copper", "rose", "iris"] as const;

/**
 * `black` is the terminal's own backdrop slot, so it is exempt. `brightBlack`
 * is the dim tier — every theme maps it onto the `ink-faint`/`ink-dim` token
 * — and so carries that tier's 2:1 floor rather than the 3:1 one the readable
 * slots get. Selection colours are 8-digit and alpha-composited, not layered
 * opaquely, so a ratio against the background would be fiction.
 */
const ANSI_READABLE = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

describe("theme contrast", () => {
  for (const theme of THEMES) {
    describe(theme.id, () => {
      const surface = theme.tokens["--color-surface"];

      it("keeps every ink tier legible on its surface", () => {
        for (const [token, min] of INK_TIERS) {
          expectContrast(theme, token, theme.tokens[token], surface, min);
        }
      });

      it("keeps every accent visible on the surface and on its own wash", () => {
        // The wash is the accent's own tinted plane (a badge, a callout), so
        // an accent that only clears the surface still vanishes inside itself.
        for (const accent of ACCENTS) {
          const colour = theme.tokens[`--color-${accent}`];
          expectContrast(theme, `${accent} on surface`, colour, surface, 3);
          expectContrast(
            theme,
            `${accent} on wash`,
            colour,
            theme.tokens[`--color-${accent}-wash`],
            3,
          );
        }
      });

      it("keeps every syntax colour readable on the surface", () => {
        for (const [role, colour] of Object.entries(theme.code)) {
          expectContrast(theme, `code.${role}`, colour, surface, 3);
        }
      });

      it("keeps every readable ANSI slot legible on the terminal background", () => {
        const background = theme.term.background;
        for (const slot of ANSI_READABLE) {
          expectContrast(theme, `term.${slot}`, theme.term[slot], background, 3);
        }
        expectContrast(theme, "term.brightBlack", theme.term.brightBlack, background, 2);
      });

      it("keeps the depth planes distinguishable", () => {
        // Equal planes collapse the elevation model: a modal stops reading as
        // floating, a hovered row stops answering "am I on it?".
        const t = theme.tokens;
        expect(t["--color-void"]).not.toBe(t["--color-surface"]);
        expect(t["--color-surface"]).not.toBe(t["--color-raised"]);
        expect(t["--color-overlay"]).not.toBe(t["--color-surface"]);
        expect(t["--color-hover"]).not.toBe(t["--color-raised"]);
      });
    });
  }

  it("gives every theme the same token key set", () => {
    // `applyTheme` only writes the keys a theme holds, so a missing key would
    // silently leave the *previous* theme's value applied after a switch.
    const expected = Object.keys(THEMES[0].tokens).sort();
    for (const theme of THEMES) {
      expect(`${theme.id}: ${Object.keys(theme.tokens).sort().join(",")}`).toBe(
        `${theme.id}: ${expected.join(",")}`,
      );
    }
  });

  it("gives every theme a unique id", () => {
    // The id is the persisted key and shiki's theme name; a collision would
    // make one theme unreachable.
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
