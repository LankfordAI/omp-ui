import { describe, expect, it } from "vitest";
import themeSources from "./theme-sources.json";
import type { ThemeSource } from "./theme";
import {
  BACKDROP_IMAGE_BYTES_MAX,
  BACKDROP_VIDEO_BYTES_MAX,
  backdropFloors,
  checkBackdropBytes,
  isThemeBackdrop,
  sceneFrameHtml,
  stillScene,
} from "./theme-backdrop";

const curated = themeSources as ThemeSource[];
const byId = (id: string): ThemeSource => curated.find((theme) => theme.id === id)!;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const svg = (body: string): Uint8Array =>
  utf8(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);

function mp4Ftyp(majorBrand: string, compat: readonly string[] = [], extendedSize = false): Uint8Array {
  const size = (extendedSize ? 16 : 8) + 8 + compat.length * 4;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, extendedSize ? 1 : size, false);
  bytes.set(utf8("ftyp"), 4);
  let offset = 8;
  if (extendedSize) {
    view.setUint32(8, 0, false);
    view.setUint32(12, size, false);
    offset = 16;
  }
  bytes.set(utf8(majorBrand), offset);
  bytes.set([0, 0, 2, 0], offset + 4);
  for (let i = 0; i < compat.length; i++) bytes.set(utf8(compat[i]!), offset + 8 + i * 4);
  return bytes;
}

function ebmlHeader(children: Uint8Array[]): Uint8Array {
  const bodyLength = children.reduce((sum, child) => sum + child.length, 0);
  if (bodyLength >= 0x7f) throw new Error("test helper supports < 127 byte EBML headers");
  const out = new Uint8Array(5 + bodyLength);
  out.set([0x1a, 0x45, 0xdf, 0xa3, 0x80 | bodyLength], 0);
  let pos = 5;
  for (const child of children) {
    out.set(child, pos);
    pos += child.length;
  }
  return out;
}

function ebmlString(id: readonly number[], value: string, trailingZeroes = 0): Uint8Array {
  const raw = utf8(value);
  const len = raw.length + trailingZeroes;
  const out = new Uint8Array(id.length + 1 + len);
  out.set(id, 0);
  out[id.length] = 0x80 | len;
  out.set(raw, id.length + 1);
  return out;
}

describe("backdropFloors", () => {
  it.each([
    ["graphite", { void: 81, sunken: 82, reading: 87, overlay: 55 }],
    ["nord", { void: 78, sunken: 81, reading: 97, overlay: 50 }],
    ["light", { void: 88, sunken: 86, reading: 83, overlay: 50 }],
    ["solarized-light", { void: 89, sunken: 86, reading: 93, overlay: 50 }],
  ] as const)("%s", (id, expected) => {
    expect(backdropFloors(byId(id).tokens)).toEqual(expected);
  });

  it("returns 100 for a plane whose text fails even when opaque", () => {
    const tokens = { ...byId("graphite").tokens };
    tokens["--color-sunken"] = tokens["--color-ink-faint"];
    expect(backdropFloors(tokens).sunken).toBe(100);
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

  it("accepts a 4 MiB scene and refuses one byte more", () => {
    const scene = svg(" ".repeat(4 * 1024 * 1024 - svg("").length));
    expect(checkBackdropBytes(scene)).toEqual({ ok: true, kind: "scene", mime: "image/svg+xml" });
    const oversized = new Uint8Array(scene.length + 1);
    oversized.set(scene);
    oversized[scene.length] = 0x20;
    expect(checkBackdropBytes(oversized).ok).toBe(false);
  });
  it("accepts valid MP4 (standard and 64-bit extended size) and WebM containers", () => {
    for (const sample of [
      mp4Ftyp("isom", ["isom", "av01", "iso2", "mp41"]),
      mp4Ftyp("mp42", ["mp42", "isom"]),
      mp4Ftyp("av01"),
      mp4Ftyp("isom", ["mp41"], true),
    ]) {
      expect(checkBackdropBytes(sample)).toEqual({ ok: true, kind: "video", mime: "video/mp4" });
    }
    expect(checkBackdropBytes(ebmlHeader([ebmlString([0x42, 0x82], "webm")]))).toEqual({
      ok: true,
      kind: "video",
      mime: "video/webm",
    });
    expect(checkBackdropBytes(ebmlHeader([ebmlString([0x42, 0x82], "webm", 2)]))).toEqual({
      ok: true,
      kind: "video",
      mime: "video/webm",
    });
  });

  it("accepts a 16 MiB video and refuses one byte more", () => {
    const atMax = new Uint8Array(BACKDROP_VIDEO_BYTES_MAX);
    atMax.set(mp4Ftyp("isom", ["mp41"]));
    expect(checkBackdropBytes(atMax)).toEqual({ ok: true, kind: "video", mime: "video/mp4" });
    const over = new Uint8Array(BACKDROP_VIDEO_BYTES_MAX + 1);
    over.set(mp4Ftyp("isom", ["mp41"]));
    expect(checkBackdropBytes(over)).toEqual({ ok: false, message: "video backdrops can be at most 16 MiB" });
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
    ["script", svg("<script>alert(1)</script>")],
    ["foreignObject", svg("<foreignObject/>")],
    ["SMIL", svg('<animate attributeName="x"/>')],
    ["external href", svg('<image href="https://example.com/a.png"/>')],
    ["@import", svg("<style>@import 'x.css';</style>")],
    ["external url()", svg('<rect fill="url(https://example.com/a.svg#g)"/>')],
    ["QuickTime MOV", mp4Ftyp("qt  ")],
    ["AVIF", mp4Ftyp("avif")],
    ["HEIC", mp4Ftyp("heic")],
    ["truncated 12-byte MP4 ftyp", new Uint8Array([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])],
    ["extended-size MP4 with size < 24", new Uint8Array([0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 20, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])],
    ["extended-size MP4 exceeding length", new Uint8Array([0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 40, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])],
    [
      "Matroska with stray webm string",
      ebmlHeader([ebmlString([0x42, 0x86], "webm"), ebmlString([0x42, 0x82], "matroska")]),
    ],
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

describe("sceneFrameHtml", () => {
  it("wraps SVG with CSP, strips XML/DOCTYPE declarations, and injects preserveAspectRatio when absent", () => {
    const raw = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg viewBox="0 0 10 10"><rect/></svg>`;
    const html = sceneFrameHtml(raw);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:;");
    expect(html).not.toContain("<?xml");
    expect(html).not.toContain("<!DOCTYPE svg");
    expect(html).toContain('<svg viewBox="0 0 10 10" preserveAspectRatio="xMidYMid slice"><rect/></svg>');
  });

  it("preserves an existing preserveAspectRatio attribute", () => {
    const html = sceneFrameHtml('<svg viewBox="0 0 10 10" preserveAspectRatio="none"><rect/></svg>');
    expect(html).toContain('<svg viewBox="0 0 10 10" preserveAspectRatio="none"><rect/></svg>');
    expect(html).not.toContain("xMidYMid slice");
  });
});

describe("isThemeBackdrop", () => {
  const valid = { assetHash: "a".repeat(64), kind: "scene", mime: "image/svg+xml", blur: 12 };

  it("accepts well-formed references for image, scene, and video", () => {
    expect(isThemeBackdrop(valid)).toBe(true);
    expect(isThemeBackdrop({ ...valid, kind: "image", mime: "image/png" })).toBe(true);
    expect(isThemeBackdrop({ ...valid, kind: "video", mime: "video/mp4" })).toBe(true);
    expect(isThemeBackdrop({ ...valid, kind: "video", mime: "video/webm" })).toBe(true);
  });

  it("refuses mismatched kind/mime pairs, an out-of-range blur, or an extra key", () => {
    expect(isThemeBackdrop({ ...valid, mime: "image/png" })).toBe(false);
    expect(isThemeBackdrop({ ...valid, kind: "video", mime: "image/png" })).toBe(false);
    expect(isThemeBackdrop({ ...valid, kind: "image", mime: "video/mp4" })).toBe(false);
    expect(isThemeBackdrop({ ...valid, blur: 33 })).toBe(false);
    expect(isThemeBackdrop({ ...valid, extra: true })).toBe(false);
  });
});
