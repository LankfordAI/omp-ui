import { describe, expect, it } from "vitest";
import { BACKDROP_BYTES_MAX } from "./theme-backdrop";
import { THEME_FILE_FORMAT, isStoredThemeDraft, parseThemeFile, type ThemeFile } from "./theme-file";

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

  it("round-trips a video/mp4 theme file to a draft", () => {
    const mp4File: ThemeFile = {
      ...file,
      backdrop: { mime: "video/mp4", data: "AAAAIGZ0eXBpc29tAAACAGlzb20=", blur: 8 },
    };
    expect(parseThemeFile(JSON.stringify(mp4File))).toEqual({
      ok: true,
      draft: {
        label: "Dusk",
        seeds: file.seeds,
        backdrop: { from: "bytes", data: "AAAAIGZ0eXBpc29tAAACAGlzb20=", blur: 8 },
      },
    });
  });

  it("falls back to JSONC when the file contains comments or trailing commas", () => {
    const jsonc = `// authored theme\n${JSON.stringify(file, null, 2).replace('"blur": 12', '"blur": 12,')}`;
    expect(parseThemeFile(jsonc)).toMatchObject({
      ok: true,
      draft: { label: "Dusk", backdrop: { from: "bytes", data: "iVBORw0KGgo=", blur: 12 } },
    });
  });

  it("accepts base64 payloads up to 16 MiB decoded and rejects one chunk larger", () => {
    const maxB64Len = Math.ceil(BACKDROP_BYTES_MAX / 3) * 4;
    expect(
      isStoredThemeDraft({
        label: "Dusk",
        seeds: file.seeds,
        backdrop: { from: "bytes", data: "A".repeat(maxB64Len), blur: 0 },
      }),
    ).toBe(true);
    expect(
      isStoredThemeDraft({
        label: "Dusk",
        seeds: file.seeds,
        backdrop: { from: "bytes", data: "A".repeat(maxB64Len + 4), blur: 0 },
      }),
    ).toBe(false);
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
