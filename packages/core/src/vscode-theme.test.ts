import { describe, expect, it } from "vitest";
import { deriveTheme, effectiveThemeId, parseImportedThemes, themeContrastFailures } from "./theme";
import { importVsCodeThemeFiles, stripJsonc } from "./vscode-theme";

// Shaped like VS Code's built-in Dark Modern / Dark+ pair: JSONC with line
// comments and trailing commas, and a child that names its parent through
// `include`, the way every built-in theme does.
const DARK_PLUS = `{
  "$schema": "vscode://schemas/color-theme",
  "name": "Dark+",
  "colors": {
    "editor.background": "#1E1E1E",
    "editor.foreground": "#D4D4D4", // trailing comment
  },
  "tokenColors": [
    { "scope": ["comment"], "settings": { "foreground": "#6A9955" } },
    { "scope": "string", "settings": { "foreground": "#CE9178" } },
    { "scope": "keyword.control", "settings": { "foreground": "#C586C0" } },
    { "scope": "entity.name.function", "settings": { "foreground": "#DCDCAA" } },
  ],
}`;
const DARK_MODERN = `{
  "name": "Dark Modern",
  "include": "./dark_plus.json",
  /* block comment */
  "colors": {
    "editor.background": "#1F1F1F",
    "sideBar.background": "#181818",
    "terminal.ansiGreen": "#2EA043",
  }
}`;

describe("importVsCodeThemeFiles", () => {
  it("imports a JSONC theme through its include chain and passes the gate", () => {
    const result = importVsCodeThemeFiles([
      { name: "dark_modern.json", text: DARK_MODERN },
      { name: "dark_plus.json", text: DARK_PLUS },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { source } = result;
    expect(source.id).toBe("vscode-dark-modern");
    expect(source.label).toBe("Dark Modern");
    expect(source.dark).toBe(true);
    // The child's background wins; the parent's token rules still apply.
    expect(source.tokens["--color-surface"]).toBe("#1f1f1f");
    expect(source.tokens["--color-sunken"]).toBe("#181818");
    expect(source.syntax.function).toBe("#dcdcaa");
    expect(source.overrides?.code?.keyword).toBe("#c586c0");
    expect(themeContrastFailures(deriveTheme(source))).toEqual([]);
  });

  it("names the include the user must pick alongside", () => {
    const result = importVsCodeThemeFiles([{ name: "dark_modern.json", text: DARK_MODERN }]);
    expect(result).toEqual({
      ok: false,
      reason: "parse",
      message: "dark_modern.json includes dark_plus.json; select it together with the theme",
    });
  });

  it("lifts a low-contrast accent and syntax colour to the floor instead of refusing", () => {
    // Dim green and a near-background comment colour: the mapping must keep
    // them readable, so the theme still imports.
    const text = JSON.stringify({
      name: "Dim",
      type: "dark",
      colors: { "editor.background": "#202020", "editor.foreground": "#f0f0f0", "terminal.ansiGreen": "#1f3f1f" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#262626" } }],
    });
    const result = importVsCodeThemeFiles([{ name: "dim.json", text }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(themeContrastFailures(deriveTheme(result.source))).toEqual([]);
  });

  it("refuses a theme whose reading ink cannot reach the floor and reports the pairing", () => {
    // A mid-grey editor: no ink reaches 10:1 on #777777, so the gate fails
    // and the theme is not saved.
    const text = JSON.stringify({
      name: "Fog",
      colors: { "editor.background": "#777777", "editor.foreground": "#888888" },
    });
    const result = importVsCodeThemeFiles([{ name: "fog.json", text }]);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "contrast") throw new Error("expected a contrast failure");
    expect(result.label).toBe("Fog");
    expect(result.failures.map((f) => f.label)).toContain("--color-ink");
  });

  it("rejects text that is not a colour theme", () => {
    expect(importVsCodeThemeFiles([{ name: "x.json", text: "[1, 2]" }])).toMatchObject({ ok: false, reason: "parse" });
    expect(importVsCodeThemeFiles([{ name: "x.json", text: "{ nope" }])).toMatchObject({ ok: false, reason: "parse" });
    expect(
      importVsCodeThemeFiles([{ name: "x.json", text: '{"name":"T","tokenColors":"./x.tmTheme"}' }]),
    ).toMatchObject({ ok: false, reason: "parse" });
  });
});

describe("stripJsonc", () => {
  it("keeps // inside strings", () => {
    expect(JSON.parse(stripJsonc('{"a": "http://x//y", // c\n "b": 1,}'))).toEqual({ a: "http://x//y", b: 1 });
  });
});

describe("parseImportedThemes", () => {
  it("drops a stored theme that fails the contrast gate", () => {
    const good = importVsCodeThemeFiles([
      { name: "dark_modern.json", text: DARK_MODERN },
      { name: "dark_plus.json", text: DARK_PLUS },
    ]);
    if (!good.ok) throw new Error("fixture failed");
    const unreadable = {
      ...good.source,
      id: "vscode-unreadable",
      tokens: { ...good.source.tokens, "--color-ink": good.source.tokens["--color-surface"] },
    };
    expect(parseImportedThemes([good.source, unreadable, good.source]).map((t) => t.id)).toEqual([
      "vscode-dark-modern",
    ]);
  });
});

describe("effectiveThemeId", () => {
  const preference = { themeId: "monokai", lightThemeId: "light", darkThemeId: "nord" };
  it("follows the OS scheme only in system mode", () => {
    expect(effectiveThemeId({ ...preference, themeMode: "fixed" }, true)).toBe("monokai");
    expect(effectiveThemeId({ ...preference, themeMode: "system" }, true)).toBe("nord");
    expect(effectiveThemeId({ ...preference, themeMode: "system" }, false)).toBe("light");
  });
});
