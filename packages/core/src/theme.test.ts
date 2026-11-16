import { describe, expect, it } from "vitest";
import themeSources from "../../desktop/src/renderer/src/lib/theme-sources.json";
import { deriveTheme, isStoredTheme, signalAccentFailure, themeGateFailures, type ThemeSource } from "./theme";

const graphite = (themeSources as ThemeSource[]).find((theme) => theme.id === "graphite")!;

describe("isStoredTheme", () => {
  it("accepts imported and authored ids and refuses a curated one", () => {
    expect(isStoredTheme({ ...graphite, id: "vscode-x" })).toBe(true);
    expect(isStoredTheme({ ...graphite, id: "custom-x" })).toBe(true);
    expect(isStoredTheme(graphite)).toBe(false);
  });
});

describe("signalAccentFailure", () => {
  it.each([
    ["#f57d94", false],
    ["#e5e510", true],
    ["#11a8cd", false],
    ["#9aa0a8", false],
  ])("%s accepted: %s", (colour, accepted) => {
    expect(signalAccentFailure(colour) === null).toBe(accepted);
  });
});

describe("themeGateFailures", () => {
  it("holds an authored theme's signal to green but exempts an imported one", () => {
    const tokens = { ...graphite.tokens, "--color-signal": "#f57d94" };
    expect(themeGateFailures({ ...graphite, id: "custom-red", tokens })).toContainEqual(
      expect.objectContaining({ kind: "signal" }),
    );
    expect(themeGateFailures({ ...graphite, id: "vscode-red", tokens }).some((f) => f.kind === "signal")).toBe(false);
  });
});

describe("deriveTheme rev", () => {
  it("changes with a colour and is stable for equal colours", () => {
    const base = deriveTheme(graphite).rev;
    expect(deriveTheme({ ...graphite, id: "custom-copy", label: "Copy" }).rev).toBe(base);
    const recoloured = { ...graphite, tokens: { ...graphite.tokens, "--color-ink": "#ffffff" } };
    expect(deriveTheme(recoloured).rev).not.toBe(base);
  });
});
