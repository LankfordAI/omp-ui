import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectProjectIcon,
  icoBestImage,
  isProjectIcon,
  PROJECT_ICON_PASSTHROUGH_BYTES,
  projectIconDataUrl,
  type RasterNormalizer,
} from "./project-icon";
import { Registry } from "./registry";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-icon-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG-signed payload tagged so the fake normalizer's output names its input. */
function png(tag: number): Uint8Array {
  return new Uint8Array([...PNG_SIG, tag]);
}
/** Stands in for nativeImage: echoes the tag byte, refuses a 0xEE-tagged "corrupt" PNG. */
const normalize: RasterNormalizer = (bytes) => (bytes[8] === 0xee ? null : new Uint8Array([...PNG_SIG, bytes[8]!, 0x01]));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

/** An ICO directory with the given entries; each entry's payload is its own bytes. */
function ico(entries: { width: number; bpp: number; data: Uint8Array }[]): Uint8Array {
  const header = 6 + entries.length * 16;
  const total = header + entries.reduce((n, e) => n + e.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, entries.length, true);
  let offset = header;
  entries.forEach((entry, i) => {
    const at = 6 + i * 16;
    out[at] = entry.width === 256 ? 0 : entry.width;
    out[at + 1] = out[at];
    view.setUint16(at + 6, entry.bpp, true);
    view.setUint32(at + 8, entry.data.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(entry.data, offset);
    offset += entry.data.length;
  });
  return out;
}

function write(root: string, rel: string, bytes: Uint8Array | string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
}

describe("icoBestImage", () => {
  it("prefers the entry nearest 64px, larger over equally near smaller, deeper colour on ties", () => {
    const best = icoBestImage(
      ico([
        { width: 16, bpp: 32, data: png(16) },
        { width: 48, bpp: 32, data: png(48) },
        { width: 80, bpp: 8, data: png(1) },
        { width: 80, bpp: 32, data: png(80) },
        { width: 256, bpp: 32, data: png(255) },
      ]),
    );
    expect(best?.mime).toBe("image/png");
    expect(best?.bytes[8]).toBe(80);
  });

  it("rebuilds a bitmap entry as a single-image ICO the renderer can decode", () => {
    const bmp = new Uint8Array([0x28, 0, 0, 0, 1, 2, 3]);
    const best = icoBestImage(ico([{ width: 32, bpp: 32, data: bmp }]));
    expect(best?.mime).toBe("image/x-icon");
    const again = icoBestImage(best!.bytes);
    expect(Array.from(again!.bytes.subarray(22))).toEqual(Array.from(bmp));
  });

  it("rejects a directory whose entries point past the file", () => {
    const broken = ico([{ width: 32, bpp: 32, data: png(1) }]);
    new DataView(broken.buffer).setUint32(6 + 12, 9999, true);
    expect(icoBestImage(broken)).toBeNull();
  });
});

describe("projectIconDataUrl", () => {
  it("normalizes PNG, passes a small SVG through, and refuses non-images by content", () => {
    expect(projectIconDataUrl(png(7), normalize)).toBe(`data:image/png;base64,${Buffer.from([...PNG_SIG, 7, 1]).toString("base64")}`);
    expect(projectIconDataUrl(Buffer.from(SVG), normalize)).toMatch(/^data:image\/svg\+xml;base64,/);
    // A text file named favicon.png is still not an image.
    expect(projectIconDataUrl(Buffer.from("not an icon"), normalize)).toBeNull();
  });

  it("drops a pass-through format over the broadcast cap", () => {
    const big = Buffer.from(SVG + " ".repeat(PROJECT_ICON_PASSTHROUGH_BYTES));
    expect(projectIconDataUrl(big, normalize)).toBeNull();
  });
});

describe("detectProjectIcon", () => {
  it("finds nothing in a bare checkout", async () => {
    expect(await detectProjectIcon(tmpDir(), normalize)).toBeNull();
  });

  it("takes the first location in order: root favicon.ico before public/", async () => {
    const root = tmpDir();
    write(root, "public/favicon.png", png(2));
    write(root, "favicon.ico", ico([{ width: 64, bpp: 32, data: png(1) }]));
    expect((await detectProjectIcon(root, normalize))?.file).toBe("favicon.ico");
  });

  it("prefers a vector in one location and skips a candidate that does not decode", async () => {
    const root = tmpDir();
    write(root, "public/favicon.png", png(0xee));
    write(root, "app/icon.png", png(3));
    write(root, "app/icon.svg", SVG);
    const found = await detectProjectIcon(root, normalize);
    expect(found?.file).toBe("app/icon.svg");
    fs.rmSync(path.join(root, "app/icon.svg"));
    expect((await detectProjectIcon(root, normalize))?.file).toBe("app/icon.png");
  });

  it("ignores a directory named like a candidate", async () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "favicon.ico"));
    write(root, "assets/icon.png", png(4));
    expect((await detectProjectIcon(root, normalize))?.file).toBe("assets/icon.png");
  });
});

describe("project icon persistence", () => {
  it("round-trips through the registry and drops a malformed icon without losing the project", () => {
    const dir = tmpDir();
    const file = path.join(dir, "registry.json");
    const registry = Registry.load(file);
    registry.addProject("/p/a");
    registry.addProject("/p/b");
    const icon = { source: "custom", dataUrl: "data:image/png;base64,iVBORw0KGgo=" } as const;
    expect(registry.setProjectIcon("/p/a", icon)).toBe(true);
    expect(registry.setProjectIcon("/p/a", { ...icon })).toBe(false);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.projects[1].icon = { source: "custom", dataUrl: "javascript:alert(1)" };
    fs.writeFileSync(file, JSON.stringify(raw));
    const reloaded = Registry.load(file);
    expect(reloaded.projects.map((p) => p.icon)).toEqual([icon, null]);
  });

  it("guards the detected file against paths outside the candidate list", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    expect(isProjectIcon({ source: "detected", file: "public/favicon.png", dataUrl })).toBe(true);
    expect(isProjectIcon({ source: "detected", file: "../../etc/passwd", dataUrl })).toBe(false);
    expect(isProjectIcon({ source: "none", extra: 1 })).toBe(false);
  });
});
