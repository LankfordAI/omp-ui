import { describe, expect, it } from "vitest";
import { THEME_FILE_FORMAT, parseThemeFile, type ThemeFile } from "./theme-file";

const file: ThemeFile = {
  format: THEME_FILE_FORMAT,
  version: 1,
  label: "Dusk",
  seeds: { canvas: "#1a1b26", accents: { signal: "#4de0a1" } },
  backdrop: { mime: "image/png", data: "iVBORw0KGgo=", blur: 12 },
};

describe("parseThemeFile", () => {
  it("round-trips an exported file to a draft without an id", () => {
    const result = parseThemeFile(JSON.stringify(file, null, 2));
    expect(result).toEqual({
      ok: true,
      draft: {
        label: "Dusk",
        seeds: file.seeds,
        backdrop: { from: "bytes", data: "iVBORw0KGgo=", blur: 12 },
      },
    });
    expect(result.ok && "id" in result.draft).toBe(false);
  });

  it("accepts a file written with the retired dim and drops it", () => {
    const legacy = { ...file, backdrop: { ...file.backdrop, dim: 40 } };
    expect(parseThemeFile(JSON.stringify(legacy))).toMatchObject({
      ok: true,
      draft: { backdrop: { from: "bytes", data: "iVBORw0KGgo=", blur: 12 } },
    });
  });

  it.each([
    ["a wrong format", JSON.stringify({ ...file, format: "vscode-theme" }), "this is not an omp-ui theme file"],
    ["a newer version", JSON.stringify({ ...file, version: 2 }), "this theme file needs a newer omp-ui"],
    ["an unknown key", JSON.stringify({ ...file, id: "custom-x-abcdef" }), "the theme file is malformed"],
    ["non-JSON", "not json", "the theme file is malformed"],
  ])("refuses %s", (_name, text, message) => {
    expect(parseThemeFile(text)).toEqual({ ok: false, message });
  });
});
