// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import themeSourcesJson from "./theme-sources.json";
import {
  THEME_TOKEN_NAMES,
  deriveCode,
  deriveTerminal,
  deriveTheme,
  mixHex,
  themeContrastFailures,
} from "@omp-ui/core/theme";
import { THEMES, type ThemeSource } from "./themes";


const THEME_SOURCES: readonly ThemeSource[] = themeSourcesJson;

describe("theme derivation", () => {
  const source: ThemeSource = { ...THEME_SOURCES[0], overrides: undefined };

  it("keeps source ids aligned with runtime ids and token keys in canonical order", () => {
    const sourceIds = THEME_SOURCES.map(({ id }) => id);
    expect(THEMES.map(({ id }) => id)).toEqual(sourceIds);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);

    for (const item of THEME_SOURCES) {
      expect(Object.keys(item.tokens)).toEqual(THEME_TOKEN_NAMES);
    }
  });

  it("contains valid source and derived colours", () => {
    const opaqueHex = /^#[0-9a-f]{6}$/;
    const terminalHex = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;
    const cssRgb = /^rgb\(\d+ \d+ \d+ \/ (?:0|1|0?\.\d+)\)$/;

    for (const item of THEME_SOURCES) {
      for (const [key, value] of Object.entries(item.tokens)) {
        expect(`${item.id} ${key} ${value}`).toSatisfy(() =>
          key === "--color-edge-hi" || key === "--color-edge-lo"
            ? cssRgb.test(value)
            : opaqueHex.test(value),
        );
      }
      for (const [key, value] of Object.entries(item.syntax)) {
        expect(`${item.id} syntax.${key} ${value}`).toSatisfy(() => opaqueHex.test(value));
      }
      for (const [key, value] of Object.entries(item.overrides?.term ?? {})) {
        expect(`${item.id} term.${key} ${value}`).toSatisfy(() => terminalHex.test(value));
      }
      for (const [key, value] of Object.entries(item.overrides?.code ?? {})) {
        expect(`${item.id} code.${key} ${value}`).toSatisfy(() => opaqueHex.test(value));
      }

      const theme = deriveTheme(item);
      for (const [key, value] of Object.entries(theme.term)) {
        expect(`${item.id} term.${key} ${value}`).toSatisfy(() => terminalHex.test(value));
      }
      for (const [key, value] of Object.entries(theme.code)) {
        expect(`${item.id} code.${key} ${value}`).toSatisfy(() => opaqueHex.test(value));
      }
    }
  });

  it("mixes opaque hex channels against ink with the documented rounding", () => {
    expect(mixHex("#336699", "#ffffff")).toBe("#7094b8");
    expect(mixHex("#336699", "#ffffff", 1)).toBe("#336699");
    expect(mixHex("#336699", "#ffffff", 0)).toBe("#ffffff");
    expect(() => mixHex("#369", "#ffffff")).toThrow("Expected #rrggbb");
    expect(() => mixHex("#336699", "#ffffff", 1.01)).toThrow("between 0 and 1");
  });

  it("maps semantic tokens and syntax seeds onto every terminal slot", () => {
    const token = source.tokens;
    const syntax = source.syntax;
    const ink = token["--color-ink"];

    expect(deriveTerminal(source)).toEqual({
      background: token["--color-surface"],
      foreground: ink,
      cursor: token["--color-signal"],
      cursorAccent: token["--color-surface"],
      selectionBackground: `${token["--color-iris"]}59`,
      selectionInactiveBackground: `${token["--color-iris"]}2e`,
      black: token["--color-sunken"],
      red: token["--color-rose"],
      green: token["--color-signal"],
      yellow: token["--color-copper"],
      blue: syntax.function,
      magenta: token["--color-iris"],
      cyan: syntax.type,
      white: token["--color-ink-mid"],
      brightBlack: token["--color-ink-faint"],
      brightRed: mixHex(token["--color-rose"], ink),
      brightGreen: mixHex(token["--color-signal"], ink),
      brightYellow: mixHex(token["--color-copper"], ink),
      brightBlue: mixHex(syntax.function, ink),
      brightMagenta: mixHex(token["--color-iris"], ink),
      brightCyan: mixHex(syntax.type, ink),
      brightWhite: ink,
    });

    const light = deriveTerminal({ ...source, dark: false });
    expect(light.black).toBe(ink);
    expect(light.brightBlack).toBe(token["--color-ink-dim"]);
  });

  it("maps semantic tokens and syntax seeds onto every code role", () => {
    const token = source.tokens;
    const syntax = source.syntax;
    expect(deriveCode(source)).toEqual({
      foreground: token["--color-ink"],
      comment: syntax.comment,
      string: syntax.string,
      constant: syntax.constant,
      keyword: token["--color-iris"],
      function: syntax.function,
      type: syntax.type,
      property: syntax.property,
      punctuation: token["--color-ink-mid"],
      inserted: token["--color-signal"],
      deleted: token["--color-rose"],
    });
  });

  it("projects semantic changes through consumers unless a final override wins", () => {
    const changed: ThemeSource = {
      ...source,
      tokens: {
        ...source.tokens,
        "--color-surface": "#010203",
        "--color-signal": "#123456",
        "--color-rose": "#654321",
        "--color-iris": "#abcdef",
      },
    };
    const projected = deriveTheme(changed);
    expect(projected.term.background).toBe("#010203");
    expect(projected.term.cursor).toBe("#123456");
    expect(projected.term.green).toBe("#123456");
    expect(projected.term.red).toBe("#654321");
    expect(projected.term.magenta).toBe("#abcdef");
    expect(projected.code.inserted).toBe("#123456");
    expect(projected.code.deleted).toBe("#654321");
    expect(projected.code.keyword).toBe("#abcdef");

    const overridden: ThemeSource = {
      ...changed,
      overrides: {
        term: { background: "#111111", red: "#222222", brightRed: "#333333" },
        code: { deleted: "#444444" },
      },
    };
    const theme = deriveTheme(overridden);
    expect(theme.term.background).toBe("#111111");
    expect(theme.term.red).toBe("#222222");
    expect(theme.term.brightRed).toBe("#333333");
    expect(theme.code.deleted).toBe("#444444");

    const inheritedBright = deriveTerminal({
      ...changed,
      overrides: { term: { red: "#222222" } },
    });
    expect(inheritedBright.brightRed).toBe(mixHex("#222222", changed.tokens["--color-ink"]));
  });

  it("stores only overrides that change their projected slot", () => {
    for (const item of THEME_SOURCES) {
      for (const section of ["term", "code"] as const) {
        const overrides = item.overrides?.[section] ?? {};
        for (const [slot, value] of Object.entries(overrides)) {
          const withoutSlot = Object.fromEntries(
            Object.entries(overrides).filter(([key]) => key !== slot),
          );
          const changed: ThemeSource = {
            ...item,
            overrides: { ...item.overrides, [section]: withoutSlot },
          };
          const projected = section === "term" ? deriveTerminal(changed) : deriveCode(changed);
          const projectedValue = Object.entries(projected).find(([key]) => key === slot)?.[1];
          expect(`${item.id} ${section}.${slot}`).toSatisfy(() => projectedValue !== value);
        }
      }
    }
  });
});

describe("theme contrast", () => {
  // The gate lives in @omp-ui/core/theme so an imported theme (issue #999)
  // meets exactly the floors every curated theme meets here. A failure names
  // the pairing and its ratio, not just a boolean.
  for (const theme of THEMES) {
    it(`${theme.id} passes the contrast gate`, () => {
      expect(themeContrastFailures(theme)).toEqual([]);
    });
  }

  it("gives every theme the same token key set", () => {
    // `applyTheme` only writes the keys a theme holds, so a missing key would
    // silently leave the *previous* theme's value applied after a switch.
    const expected = Object.keys(THEMES[0]!.tokens).sort();
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
