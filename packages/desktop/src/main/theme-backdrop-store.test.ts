import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeBackdropStore } from "./theme-backdrop-store";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function store(): { dir: string; store: ThemeBackdropStore } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backdrops-"));
  dirs.push(base);
  const dir = path.join(base, "theme-backdrops");
  return { dir, store: new ThemeBackdropStore(dir) };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("ThemeBackdropStore (issue #1168)", () => {
  it("stores bytes under their SHA-256 and reads them back", async () => {
    const { dir, store: s } = store();
    const data = bytes("<svg></svg>");
    const hash = await s.put(data);
    expect(hash).toBe(createHash("sha256").update(data).digest("hex"));
    expect(fs.readdirSync(dir)).toEqual([hash]);
    await expect(s.read(hash)).resolves.toEqual(data);
    await expect(s.has(hash)).resolves.toBe(true);
    await expect(s.read("a".repeat(64))).resolves.toBeNull();
  });

  it("reads a malformed hash as null without touching the filesystem", async () => {
    const { store: s } = store();
    const readFile = vi.spyOn(fs.promises, "readFile");
    const stat = vi.spyOn(fs.promises, "stat");
    for (const hash of ["../registry.json", "A".repeat(64), "abc", ""]) {
      await expect(s.read(hash)).resolves.toBeNull();
      await expect(s.has(hash)).resolves.toBe(false);
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("prunes only unreferenced hash-named files", async () => {
    const { dir, store: s } = store();
    const kept = await s.put(bytes("kept"));
    const dropped = await s.put(bytes("dropped"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "not an asset");
    await s.prune(new Set([kept]));
    expect(fs.readdirSync(dir).sort()).toEqual([kept, "notes.txt"].sort());
    expect(fs.existsSync(path.join(dir, dropped))).toBe(false);
  });

  it("treats a missing directory as an empty store", async () => {
    const { store: s } = store();
    await expect(s.prune(new Set())).resolves.toBeUndefined();
    await expect(s.read("b".repeat(64))).resolves.toBeNull();
  });
});
