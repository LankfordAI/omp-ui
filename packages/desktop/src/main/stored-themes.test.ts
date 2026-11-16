import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { Registry, STORED_THEMES_MAX, sourceFromDraft, type StoredThemeDraft, type ThemeSource } from "@omp-ui/core";
import {
  installStoredTheme,
  removeStoredTheme,
  saveStoredTheme,
  setStoredThemeMotion,
  type StoredThemeDeps,
} from "./stored-themes";
import { ThemeBackdropStore } from "./theme-backdrop-store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PASSING = { canvas: "#1a1b26" };
const SCENE = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
const OTHER_SCENE = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

function setup(): { deps: StoredThemeDeps; registry: Registry; backdropDir: string; broadcast: Mock } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-stored-themes-"));
  dirs.push(dir);
  const registry = Registry.load(path.join(dir, "registry.json"));
  const backdropDir = path.join(dir, "theme-backdrops");
  const broadcast = vi.fn(async () => {});
  let next = 0;
  const deps: StoredThemeDeps = {
    registry,
    broadcast,
    backdrops: new ThemeBackdropStore(backdropDir),
    newId: () => `custom-t${++next}`,
  };
  return { deps, registry, backdropDir, broadcast };
}

const assets = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

function draft(overrides: Partial<StoredThemeDraft> = {}): StoredThemeDraft {
  return { label: "Night", seeds: PASSING, backdrop: null, ...overrides };
}

describe("saveStoredTheme (issue #1168)", () => {
  it("saves a valid draft and stores its backdrop bytes under their hash", async () => {
    const { deps, registry, backdropDir, broadcast } = setup();
    const result = await saveStoredTheme(deps, draft({ backdrop: { from: "bytes", data: b64(SCENE), dim: 40, blur: 12 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.id).toBe("custom-t1");
    expect(result.source.backdrop).toMatchObject({ kind: "scene", mime: "image/svg+xml", dim: 40, blur: 12 });
    expect(registry.getSetting("storedThemes").map((t) => t.id)).toEqual(["custom-t1"]);
    expect(assets(backdropDir)).toEqual([result.source.backdrop!.assetHash]);
    expect(fs.readFileSync(path.join(backdropDir, result.source.backdrop!.assetHash), "utf8")).toBe(SCENE);
    expect(broadcast).toHaveBeenCalled();
  });

  it("writes nothing for a draft the gate refuses", async () => {
    const { deps, registry, backdropDir, broadcast } = setup();
    const result = await saveStoredTheme(deps, draft({
      seeds: { canvas: "#808080" },
      backdrop: { from: "bytes", data: b64(SCENE), dim: 40, blur: 12 },
    }));
    expect(result).toMatchObject({ ok: false, reason: "gate" });
    expect(registry.getSetting("storedThemes")).toEqual([]);
    expect(assets(backdropDir)).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("replaces an authored theme in place and prunes the asset it no longer uses", async () => {
    const { deps, registry, backdropDir } = setup();
    const first = await saveStoredTheme(deps, draft({ label: "First", backdrop: { from: "bytes", data: b64(SCENE), dim: 40, blur: 12 } }));
    await saveStoredTheme(deps, draft({ label: "Second" }));
    if (!first.ok) throw new Error("first save failed");
    const oldHash = first.source.backdrop!.assetHash;
    const replaced = await saveStoredTheme(deps, draft({
      id: first.source.id,
      label: "First again",
      backdrop: { from: "bytes", data: b64(OTHER_SCENE), dim: 20, blur: 4 },
    }));
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(registry.getSetting("storedThemes").map((t) => [t.id, t.label])).toEqual([
      ["custom-t1", "First again"],
      ["custom-t2", "Second"],
    ]);
    expect(assets(backdropDir)).toEqual([replaced.source.backdrop!.assetHash]);
    expect(assets(backdropDir)).not.toContain(oldHash);
  });

  it("refuses to replace an imported theme", async () => {
    const { deps, registry } = setup();
    const imported = sourceFromDraft("vscode-dusk", "Dusk", PASSING);
    registry.setSetting("storedThemes", [imported]);
    const result = await saveStoredTheme(deps, draft({ id: "vscode-dusk" }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(registry.getSetting("storedThemes")).toEqual([imported]);
  });

  it("refuses an id that names no stored theme", async () => {
    const { deps, registry } = setup();
    const result = await saveStoredTheme(deps, draft({ id: "custom-missing" }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(registry.getSetting("storedThemes")).toEqual([]);
  });

  it("refuses a theme past the cap but still replaces one of a full list", async () => {
    const { deps, registry } = setup();
    const full: ThemeSource[] = Array.from({ length: STORED_THEMES_MAX }, (_, i) =>
      sourceFromDraft(`custom-full${i}`, `Full ${i}`, PASSING));
    registry.setSetting("storedThemes", full);
    await expect(saveStoredTheme(deps, draft())).resolves.toMatchObject({ ok: false, reason: "invalid" });
    expect(registry.getSetting("storedThemes")).toHaveLength(STORED_THEMES_MAX);
    const replaced = await saveStoredTheme(deps, draft({ id: "custom-full5", label: "Replaced" }));
    expect(replaced.ok).toBe(true);
    const after = registry.getSetting("storedThemes");
    expect(after).toHaveLength(STORED_THEMES_MAX);
    expect(after[5]).toMatchObject({ id: "custom-full5", label: "Replaced" });
  });

  it("refuses an asset backdrop whose hash is not stored", async () => {
    const { deps, registry } = setup();
    const result = await saveStoredTheme(deps, draft({
      backdrop: { from: "asset", assetHash: "c".repeat(64), dim: 40, blur: 12 },
    }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(registry.getSetting("storedThemes")).toEqual([]);
  });

  it("reuses a stored asset for a duplicate", async () => {
    const { deps, backdropDir } = setup();
    const first = await saveStoredTheme(deps, draft({ backdrop: { from: "bytes", data: b64(SCENE), dim: 40, blur: 12 } }));
    if (!first.ok) throw new Error("first save failed");
    const hash = first.source.backdrop!.assetHash;
    const copy = await saveStoredTheme(deps, draft({ label: "Night copy", backdrop: { from: "asset", assetHash: hash, dim: 60, blur: 0 } }));
    expect(copy).toMatchObject({ ok: true, source: { backdrop: { assetHash: hash, kind: "scene", dim: 60, blur: 0 } } });
    expect(assets(backdropDir)).toEqual([hash]);
  });

  it("keeps both assets when two backdrop saves run at once", async () => {
    const { deps, registry } = setup();
    // An in-memory store whose operations settle in microtasks, so the second
    // save runs to completion before the first save's held put is released
    // one macrotask later. Without serialization that second save prunes the
    // first save's asset before the registry names it.
    const files = new Map<string, Uint8Array>();
    const held = Promise.withResolvers<void>();
    let puts = 0;
    deps.backdrops = {
      put: async (bytes: Uint8Array) => {
        const hash = createHash("sha256").update(bytes).digest("hex");
        files.set(hash, bytes);
        if (puts++ === 0) await held.promise;
        return hash;
      },
      read: async (hash: string) => files.get(hash) ?? null,
      has: async (hash: string) => files.has(hash),
      prune: async (keep: ReadonlySet<string>) => {
        for (const hash of [...files.keys()]) if (!keep.has(hash)) files.delete(hash);
      },
    } as unknown as ThemeBackdropStore;
    const saving = Promise.all([
      saveStoredTheme(deps, draft({ label: "A", backdrop: { from: "bytes", data: b64(SCENE), dim: 40, blur: 12 } })),
      saveStoredTheme(deps, draft({ label: "B", backdrop: { from: "bytes", data: b64(OTHER_SCENE), dim: 40, blur: 12 } })),
    ]);
    setImmediate(held.resolve);
    const [a, b] = await saving;
    if (!a.ok || !b.ok) throw new Error("save failed");
    expect(registry.getSetting("storedThemes")).toHaveLength(2);
    expect([...files.keys()].sort()).toEqual([a.source.backdrop!.assetHash, b.source.backdrop!.assetHash].sort());
  });
});

describe("removeStoredTheme (issue #1168)", () => {
  it("resets picks that named the theme and prunes its asset", async () => {
    const { deps, registry, backdropDir } = setup();
    const saved = await saveStoredTheme(deps, draft({ backdrop: { from: "bytes", data: b64(SCENE), dim: 40, blur: 12 } }));
    if (!saved.ok) throw new Error("save failed");
    registry.setSetting("themeId", saved.source.id);
    registry.setSetting("darkThemeId", saved.source.id);
    await removeStoredTheme(deps, saved.source.id);
    expect(registry.getSetting("storedThemes")).toEqual([]);
    expect(registry.getSetting("themeId")).not.toBe(saved.source.id);
    expect(registry.getSetting("darkThemeId")).not.toBe(saved.source.id);
    expect(assets(backdropDir)).toEqual([]);
  });

  // The raw settings:removeStoredTheme channel commits any string, so a
  // curated id can reach here (#1176): the pick resets below key off equality
  // with it and must not fire for an id no stored row names.
  it.each(["nord", "no-such-theme"])("changes nothing at all for the non-stored id %s", async (id) => {
    const { deps, registry, broadcast } = setup();
    registry.setSetting("themeId", id);
    registry.setSetting("darkThemeId", id);
    registry.setSetting("lightThemeId", id);
    await removeStoredTheme(deps, id);
    expect(registry.getSetting("themeId")).toBe(id);
    expect(registry.getSetting("darkThemeId")).toBe(id);
    expect(registry.getSetting("lightThemeId")).toBe(id);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("repository themes (#1178)", () => {
  const ORIGIN = { repository: "o/r", path: "a.json", commit: "a".repeat(40), blob: "b".repeat(40), animate: false };

  it("an editor save of an installed theme drops its origin", async () => {
    const { deps, registry } = setup();
    const installed = await installStoredTheme(deps, draft(), ORIGIN);
    if (!installed.ok) throw new Error("install failed");
    expect(registry.getSetting("storedThemes")[0]?.origin).toEqual(ORIGIN);
    const edited = await saveStoredTheme(deps, draft({ id: installed.source.id, label: "Edited" }));
    expect(edited.ok).toBe(true);
    const [row] = registry.getSetting("storedThemes");
    expect(row?.id).toBe(installed.source.id);
    expect(row?.origin).toBeUndefined();
  });

  it("setStoredThemeMotion changes only an origin row", async () => {
    const { deps, registry, broadcast } = setup();
    const installed = await installStoredTheme(deps, draft(), ORIGIN);
    const plain = await saveStoredTheme(deps, draft({ label: "Plain" }));
    if (!installed.ok || !plain.ok) throw new Error("save failed");
    broadcast.mockClear();
    const before = registry.getSetting("storedThemes");
    await setStoredThemeMotion(deps, plain.source.id, true);
    await setStoredThemeMotion(deps, "custom-unknown", true);
    expect(registry.getSetting("storedThemes")).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
    await setStoredThemeMotion(deps, installed.source.id, true);
    expect(registry.getSetting("storedThemes")[0]?.origin?.animate).toBe(true);
    expect(registry.getSetting("storedThemes")[1]?.origin).toBeUndefined();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
