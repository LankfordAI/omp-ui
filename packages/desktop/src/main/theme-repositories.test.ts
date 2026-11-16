import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Registry,
  STORED_THEMES_MAX,
  gitBlobSha,
  sourceFromDraft,
  type ThemeRepositoryFetch,
  type ThemeRepositoryResponse,
} from "@omp-ui/core";
import type { StoredThemeDeps } from "./stored-themes";
import { ThemeBackdropStore } from "./theme-backdrop-store";
import { ThemeRepositoryService } from "./theme-repositories";

const REPO = "owner/themes";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SCENE = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';

interface ThemeSpec {
  label: string;
  canvas: string;
  scene?: boolean;
}

function themeFile(spec: ThemeSpec): string {
  return JSON.stringify({
    format: "omp-ui-theme",
    version: 1,
    label: spec.label,
    seeds: { canvas: spec.canvas },
    ...(spec.scene === true
      ? { backdrop: { mime: "image/svg+xml", data: Buffer.from(SCENE).toString("base64"), dim: 40, blur: 12 } }
      : {}),
  });
}

/**
 * One repository with a HEAD that can move: `commits[sha]` maps each theme
 * path to the file served at that commit; `index` (optional) overrides what
 * the index lists, otherwise it mirrors each file.
 */
class FakeGitHub {
  head = C1;
  calls: string[] = [];
  commits = new Map<string, { files: Record<string, string>; index?: unknown[] }>();

  fetch: ThemeRepositoryFetch = async (url) => {
    this.calls.push(url);
    const ok = (text: string): ThemeRepositoryResponse => {
      let done = false;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => (done ? { done: true } : ((done = true), { done: false, value: encode(text) })),
            cancel: async () => {},
          }),
        },
      };
    };
    const notFound: ThemeRepositoryResponse = { ok: false, status: 404, headers: { get: () => null }, body: null };
    if (url === `https://api.github.com/repos/${REPO}/commits/HEAD`) return ok(this.head);
    for (const [sha, commit] of this.commits) {
      const files = { "omp-ui-themes.json": this.indexText(commit), ...commit.files };
      if (url === `https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`) {
        const tree = Object.entries(files).map(([p, text]) => ({
          path: p,
          type: "blob",
          sha: gitBlobSha(encode(text)),
          size: encode(text).length,
        }));
        return ok(JSON.stringify({ sha, tree, truncated: false }));
      }
      for (const [p, text] of Object.entries(files)) {
        if (url === `https://raw.githubusercontent.com/${REPO}/${sha}/${p}`) return ok(text);
      }
    }
    return notFound;
  };

  indexText(commit: { files: Record<string, string>; index?: unknown[] }): string {
    const themes =
      commit.index ??
      Object.entries(commit.files).map(([p, text]) => {
        const parsed = JSON.parse(text) as { label: string; seeds: unknown; backdrop?: unknown };
        return { path: p, label: parsed.label, seeds: parsed.seeds, backdrop: parsed.backdrop ? "scene" : null };
      });
    return JSON.stringify({ format: "omp-ui-theme-index", version: 1, themes });
  }
}

function setup(now: () => number = () => 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-theme-repos-"));
  dirs.push(dir);
  const registry = Registry.load(path.join(dir, "registry.json"));
  let next = 0;
  const themes: StoredThemeDeps = {
    registry,
    broadcast: async () => {},
    backdrops: new ThemeBackdropStore(path.join(dir, "theme-backdrops")),
    newId: () => `custom-t${++next}`,
  };
  const github = new FakeGitHub();
  const broadcast = vi.fn(async () => {});
  const service = new ThemeRepositoryService({ registry, broadcast, themes, fetch: github.fetch, now });
  return { registry, service, github, broadcast };
}

describe("ThemeRepositoryService (#1178)", () => {
  it("add canonicalizes and dedupes without fetching", async () => {
    const { registry, service, github } = setup();
    expect(await service.add("https://github.com/Owner/Themes")).toEqual({ ok: true, repository: REPO });
    expect(await service.add("owner/themes")).toEqual({ ok: true, repository: REPO });
    expect(await service.add("not a repo")).toMatchObject({ ok: false });
    expect(registry.getSetting("themeRepositories")).toEqual([REPO]);
    expect(github.calls).toEqual([]);
  });

  it("refuses to browse or install an unlisted repository without fetching", async () => {
    const { service, github } = setup();
    expect(await service.browse(REPO, false)).toEqual({ ok: false, message: "add the repository first" });
    expect(await service.install({ repository: REPO, commit: C1, path: "a.json" })).toMatchObject({
      ok: false,
      reason: "invalid",
      message: "add the repository first",
    });
    expect(github.calls).toEqual([]);
  });

  it("installs with animate off and never changes the active theme", async () => {
    const { registry, service, github } = setup();
    github.commits.set(C1, { files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26", scene: true }) } });
    await service.add(REPO);
    const result = await service.install({ repository: REPO, commit: C1, path: "dusk.json" });
    expect(result.ok).toBe(true);
    const [stored] = registry.getSetting("storedThemes");
    expect(stored?.origin).toEqual({
      repository: REPO,
      path: "dusk.json",
      commit: C1,
      blob: gitBlobSha(encode(themeFile({ label: "Dusk", canvas: "#1a1b26", scene: true }))),
      animate: false,
    });
    expect(stored?.backdrop?.kind).toBe("scene");
    expect(registry.getSetting("themeId")).toBe("graphite");
  });

  it("saves nothing for a file that disagrees with its index entry", async () => {
    const { registry, service, github } = setup();
    github.commits.set(C1, {
      files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26" }) },
      index: [{ path: "dusk.json", label: "Dusk", seeds: { canvas: "#000000" }, backdrop: null }],
    });
    await service.add(REPO);
    expect(await service.install({ repository: REPO, commit: C1, path: "dusk.json" })).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringContaining("does not match the repository's index"),
    });
    expect(registry.getSetting("storedThemes")).toEqual([]);
  });

  it("saves nothing for a theme the gate refuses", async () => {
    const { registry, service, github } = setup();
    github.commits.set(C1, { files: { "grey.json": themeFile({ label: "Grey", canvas: "#808080" }) } });
    await service.add(REPO);
    expect(await service.install({ repository: REPO, commit: C1, path: "grey.json" })).toMatchObject({
      ok: false,
      reason: "gate",
    });
    expect(registry.getSetting("storedThemes")).toEqual([]);
  });

  it("updates in place at a new commit, keeping the id, the picks and the motion choice", async () => {
    const { registry, service, github } = setup();
    github.commits.set(C1, { files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26", scene: true }) } });
    github.commits.set(C2, { files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#16161e", scene: true }) } });
    await service.add(REPO);
    const first = await service.install({ repository: REPO, commit: C1, path: "dusk.json" });
    if (!first.ok) throw new Error("install failed");
    registry.setSetting("themeId", first.source.id);
    registry.setSetting(
      "storedThemes",
      registry.getSetting("storedThemes").map((t) => ({ ...t, origin: { ...t.origin!, animate: true } })),
    );
    const updated = await service.install({ repository: REPO, commit: C2, path: "dusk.json" });
    expect(updated.ok).toBe(true);
    const stored = registry.getSetting("storedThemes");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(first.source.id);
    expect(stored[0]?.origin).toMatchObject({ commit: C2, animate: true });
    expect(stored[0]?.tokens["--color-surface"]).not.toBe(first.source.tokens["--color-surface"]);
    expect(registry.getSetting("themeId")).toBe(first.source.id);
  });

  it("refuses a new install at the cap but allows an update", async () => {
    const { registry, service, github } = setup();
    github.commits.set(C1, {
      files: {
        "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26" }),
        "night.json": themeFile({ label: "Night", canvas: "#101010" }),
      },
    });
    github.commits.set(C2, { files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#16161e" }) } });
    await service.add(REPO);
    expect((await service.install({ repository: REPO, commit: C1, path: "dusk.json" })).ok).toBe(true);
    const fillers = Array.from({ length: STORED_THEMES_MAX - 1 }, (_, i) =>
      sourceFromDraft(`custom-fill${i}`, `Fill ${i}`, { canvas: "#1a1b26" }),
    );
    registry.setSetting("storedThemes", [...registry.getSetting("storedThemes"), ...fillers]);
    expect(await service.install({ repository: REPO, commit: C1, path: "night.json" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect((await service.install({ repository: REPO, commit: C2, path: "dusk.json" })).ok).toBe(true);
    expect(registry.getSetting("storedThemes")).toHaveLength(STORED_THEMES_MAX);
  });

  it("reuses a fresh listing, refetches on refresh or after the TTL, and shares one in-flight fetch", async () => {
    let now = 0;
    const { service, github } = setup(() => now);
    github.commits.set(C1, { files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26" }) } });
    await service.add(REPO);
    const [a, b] = await Promise.all([service.browse(REPO, false), service.browse(REPO, false)]);
    expect(a).toBe(b);
    const firstCalls = github.calls.length;
    expect(firstCalls).toBe(3);
    await service.browse(REPO, false);
    expect(github.calls).toHaveLength(firstCalls);
    await service.browse(REPO, true);
    expect(github.calls).toHaveLength(firstCalls * 2);
    now += 5 * 60_000;
    await service.browse(REPO, false);
    expect(github.calls).toHaveLength(firstCalls * 3);
    // An install at the listed commit reuses the pinned listing: only the theme file is fetched.
    await service.install({ repository: REPO, commit: C1, path: "dusk.json" });
    expect(github.calls).toHaveLength(firstCalls * 3 + 1);
  });

  it("remove keeps installed themes", async () => {
    const { registry, service, github } = setup();
    github.commits.set(C1, { files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26" }) } });
    await service.add(REPO);
    await service.install({ repository: REPO, commit: C1, path: "dusk.json" });
    await service.remove(REPO);
    expect(registry.getSetting("themeRepositories")).toEqual([]);
    expect(registry.getSetting("storedThemes")).toHaveLength(1);
  });
});
