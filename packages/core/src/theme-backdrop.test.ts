import { describe, expect, it } from "vitest";
import themeSources from "../../desktop/src/renderer/src/lib/theme-sources.json";
import type { ThemeSource } from "./theme";
import {
  BACKDROP_IMAGE_BYTES_MAX,
  BACKDROP_SCENE_BYTES_MAX,
  backdropFloors,
  checkBackdropBytes,
  isThemeBackdrop,
  stillScene,
} from "./theme-backdrop";

const curated = themeSources as ThemeSource[];
const byId = (id: string): ThemeSource => curated.find((theme) => theme.id === id)!;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const svg = (body: string): Uint8Array =>
  utf8(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);

describe("backdropFloors", () => {
  it.each([
    ["graphite", 0, { void: 81, sunken: 82, reading: 87 }],
    ["graphite", 50, { void: 61, sunken: 63, reading: 72 }],
    ["nord", 0, { void: 78, sunken: 81, reading: 97 }],
    ["nord", 50, { void: 57, sunken: 61, reading: 94 }],
    ["light", 0, { void: 88, sunken: 86, reading: 83 }],
    ["light", 50, { void: 76, sunken: 72, reading: 68 }],
    ["solarized-light", 0, { void: 89, sunken: 86, reading: 93 }],
    ["solarized-light", 50, { void: 78, sunken: 73, reading: 86 }],
  ] as const)("%s at dim %i", (id, dim, expected) => {
    expect(backdropFloors(byId(id).tokens, dim)).toEqual(expected);
  });

  it("returns 100 for a plane whose text fails even when opaque", () => {
    const tokens = { ...byId("graphite").tokens };
    tokens["--color-sunken"] = tokens["--color-ink-faint"];
    expect(backdropFloors(tokens, 40).sunken).toBe(100);
  });
});

describe("checkBackdropBytes", () => {
  it("accepts a PNG as an image and a plain SVG as a scene", () => {
    expect(checkBackdropBytes(new Uint8Array([...PNG_HEAD, 0, 0, 0, 0]))).toEqual({
      ok: true,
      kind: "image",
      mime: "image/png",
    });
    expect(checkBackdropBytes(svg('<rect width="10" height="10" fill="#123456"/>'))).toEqual({
      ok: true,
      kind: "scene",
      mime: "image/svg+xml",
    });
  });

  it("accepts in-document references", () => {
    expect(checkBackdropBytes(svg('<use href="#a"/><rect fill="url(#g)"/>')).ok).toBe(true);
  });

  it.each([
    ["empty", new Uint8Array()],
    ["GIF", utf8("GIF89a\0\0")],
    ["oversized raster", (() => {
      const bytes = new Uint8Array(BACKDROP_IMAGE_BYTES_MAX + 1);
      bytes.set(PNG_HEAD);
      return bytes;
    })()],
    ["oversized SVG", svg(" ".repeat(BACKDROP_SCENE_BYTES_MAX))],
    ["script", svg("<script>alert(1)</script>")],
    ["foreignObject", svg("<foreignObject/>")],
    ["SMIL", svg('<animate attributeName="x"/>')],
    ["external href", svg('<image href="https://example.com/a.png"/>')],
    ["@import", svg("<style>@import 'x.css';</style>")],
    ["external url()", svg('<rect fill="url(https://example.com/a.svg#g)"/>')],
  ])("refuses %s", (_name, bytes) => {
    expect(checkBackdropBytes(bytes).ok).toBe(false);
  });
});

describe("stillScene", () => {
  it("inserts the still layer right after the opening tag", () => {
    const still = stillScene('<svg viewBox="0 0 1 1"><rect/></svg>');
    expect(still.startsWith('<svg viewBox="0 0 1 1"><style>@layer omp-still')).toBe(true);
    expect(still.endsWith("<rect/></svg>")).toBe(true);
  });

  it("returns non-SVG text unchanged", () => {
    expect(stillScene("not a scene")).toBe("not a scene");
  });
});

describe("isThemeBackdrop", () => {
  const valid = { assetHash: "a".repeat(64), kind: "scene", mime: "image/svg+xml", dim: 40, blur: 12 };

  it("accepts a well-formed reference", () => {
    expect(isThemeBackdrop(valid)).toBe(true);
  });

  it("refuses a scene with a raster mime, an out-of-range dim, or an extra key", () => {
    expect(isThemeBackdrop({ ...valid, mime: "image/png" })).toBe(false);
    expect(isThemeBackdrop({ ...valid, dim: 81 })).toBe(false);
    expect(isThemeBackdrop({ ...valid, extra: true })).toBe(false);
  });
});
