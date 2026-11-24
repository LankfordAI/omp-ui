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
import { OFFICIAL_THEME_REPOSITORY } from "@omp-ui/core/theme-origin";
import { saveStoredTheme, setOfficialThemes, type StoredThemeDeps } from "./stored-themes";
import { ThemeBackdropStore } from "./theme-backdrop-store";
import { ThemeRepositoryService } from "./theme-repositories";
import { readThemeUsageSample } from "./theme-usage";

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
      ? { backdrop: { mime: "image/svg+xml", data: Buffer.from(SCENE).toString("base64"), blur: 12 } }
      : {}),
  });
}

/**
 * One repository with a HEAD that can move: `commits[sha]` maps each theme
 * path to the file served at that commit; `index` (optional) overrides what
 * the index lists, otherwise it mirrors each file.
 */
class FakeGitHub {
  constructor(readonly repo: string = REPO) {}
  head = C1;
  /** Awaited before serving a raw file other than the index, so a test can hold a download open. */
  beforeTheme: (() => Promise<void>) | null = null;
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
    if (url === `https://api.github.com/repos/${this.repo}/commits/HEAD`) return ok(this.head);
    for (const [sha, commit] of this.commits) {
      const files = { "omp-ui-themes.json": this.indexText(commit), ...commit.files };
      if (url === `https://api.github.com/repos/${this.repo}/git/trees/${sha}?recursive=1`) {
        const tree = Object.entries(files).map(([p, text]) => ({
          path: p,
          type: "blob",
          sha: gitBlobSha(encode(text)),
          size: encode(text).length,
        }));
        return ok(JSON.stringify({ sha, tree, truncated: false }));
      }
      for (const [p, text] of Object.entries(files)) {
        if (url === `https://raw.githubusercontent.com/${this.repo}/${sha}/${p}`) {
          if (p !== "omp-ui-themes.json" && this.beforeTheme !== null) await this.beforeTheme();
          return ok(text);
        }
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

function setup(now: () => number = () => 0, repo: string = REPO, themesBroadcast: () => Promise<void> = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-theme-repos-"));
  dirs.push(dir);
  const registry = Registry.load(path.join(dir, "registry.json"));
  let next = 0;
  const themes: StoredThemeDeps = {
    registry,
    broadcast: themesBroadcast,
    backdrops: new ThemeBackdropStore(path.join(dir, "theme-backdrops")),
    newId: () => `custom-t${++next}`,
  };
  const github = new FakeGitHub(repo);
  const broadcast = vi.fn(async () => {});
  const service = new ThemeRepositoryService({ registry, broadcast, themes, fetch: github.fetch, now });
  return { registry, service, github, broadcast, themes };
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
    expect(await service.previewBackdrop({ repository: REPO, commit: C1, path: "a.json" })).toEqual({
      ok: false,
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
    expect(await service.previewBackdrop({ repository: REPO, commit: C1, path: "dusk.json" })).toEqual({
      ok: false,
      message: expect.stringContaining("does not match the repository's index"),
    });
    expect(registry.getSetting("storedThemes")).toEqual([]);
  });

  it("previews a backdrop through the install checks and stores nothing", async () => {
    const { registry, service, github } = setup();
    github.commits.set(C1, {
      files: {
        "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26", scene: true }),
        "plain.json": themeFile({ label: "Plain", canvas: "#101010" }),
      },
    });
    await service.add(REPO);
    expect(await service.previewBackdrop({ repository: REPO, commit: C1, path: "dusk.json" })).toEqual({
      ok: true,
      backdrop: { mime: "image/svg+xml", data: Buffer.from(SCENE).toString("base64"), blur: 12 },
    });
    expect(await service.previewBackdrop({ repository: REPO, commit: C1, path: "plain.json" })).toEqual({
      ok: false,
      message: "the theme has no backdrop",
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

  it("browses v3, previews video backdrops without storing, and installs with motion off", async () => {
    const mp4 = Buffer.from([
      0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d,
    ]).toString("base64");
    const videoTheme = JSON.stringify({
      format: "omp-ui-theme",
      version: 1,
      label: "Motion",
      seeds: { canvas: "#101820" },
      backdrop: { mime: "video/mp4", data: mp4, blur: 6 },
    });
    const v3Index = JSON.stringify({
      format: "omp-ui-theme-index",
      version: 3,
      themes: [{ path: "themes/motion.json", label: "Motion", seeds: { canvas: "#101820" }, backdrop: "video" }],
    });
    const { registry, service, github } = setup();
    github.commits.set(C1, {
      files: { "omp-ui-themes.v3.json": v3Index, "themes/motion.json": videoTheme },
    });
    await service.add(REPO);
    const listed = await service.browse(REPO, false);
    expect(listed.ok && listed.listing.themes.map((t) => [t.path, t.backdrop])).toEqual([
      ["themes/motion.json", "video"],
    ]);
    const preview = await service.previewBackdrop({ repository: REPO, commit: C1, path: "themes/motion.json" });
    expect(preview).toEqual({ ok: true, backdrop: { mime: "video/mp4", data: mp4, blur: 6 } });
    expect(registry.getSetting("storedThemes")).toEqual([]);
    const installed = await service.install({ repository: REPO, commit: C1, path: "themes/motion.json" });
    expect(installed.ok).toBe(true);
    const stored = registry.getSetting("storedThemes");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.backdrop?.kind).toBe("video");
    expect(stored[0]?.origin).toMatchObject({ repository: REPO, path: "themes/motion.json", commit: C1, animate: false });
  });
});

describe("ThemeRepositoryService official repository (#1209)", () => {
  const OFFICIAL = OFFICIAL_THEME_REPOSITORY;
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("browses and installs a new official slug without needing a catalog fetch to sample it", async () => {
    const { registry, service, github } = setup(() => 0, OFFICIAL);
    const slug = "future-midnight-2";
    const themePath = `themes/${slug}.json`;
    const files = { [themePath]: themeFile({ label: "Midnight", canvas: "#1a1b26" }) };
    github.commits.set(C1, { files });
    expect(registry.getSetting("themeRepositories")).toEqual([]);
    expect((await service.browse(OFFICIAL, false)).ok).toBe(true);
    expect(github.calls.length).toBeGreaterThan(0);
    const installed = await service.install({ repository: OFFICIAL, commit: C1, path: themePath });
    if (!installed.ok) throw new Error("official install failed");
    const preference = {
      themeMode: "fixed" as const,
      themeId: installed.source.id,
      lightThemeId: registry.getSetting("lightThemeId"),
      darkThemeId: registry.getSetting("darkThemeId"),
    };
    const callsAfterInstall = github.calls.length;
    expect(readThemeUsageSample(preference, registry.getSetting("storedThemes"), true)).toEqual({
      themeKey: `official/${slug}`,
      isDefault: false,
    });
    expect(github.calls).toHaveLength(callsAfterInstall);

    const thirdParty = setup();
    thirdParty.github.commits.set(C1, { files });
    await thirdParty.service.add(REPO);
    expect((await thirdParty.service.browse(REPO, false)).ok).toBe(true);
    const thirdPartyInstall = await thirdParty.service.install({ repository: REPO, commit: C1, path: themePath });
    if (!thirdPartyInstall.ok) throw new Error("third-party install failed");
    expect(
      readThemeUsageSample(
        { ...preference, themeId: thirdPartyInstall.source.id },
        thirdParty.registry.getSetting("storedThemes"),
        true,
      ),
    ).toEqual({ themeKey: "custom/other", isDefault: false });

    registry.setSetting("officialThemes", false);
    expect(await service.browse(OFFICIAL, true)).toEqual({ ok: false, message: "add the repository first" });
  });

  it("add and remove of the implicit official entry write nothing", async () => {
    const { registry, service, broadcast } = setup(() => 0, OFFICIAL);
    expect(await service.add(OFFICIAL)).toEqual({ ok: true, repository: OFFICIAL });
    await service.remove(OFFICIAL);
    expect(registry.getSetting("themeRepositories")).toEqual([]);
    expect(registry.getSetting("officialThemes")).toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("refuses an install whose repository is removed while the theme file downloads", async () => {
    const { registry, service, github } = setup();
    github.commits.set(C1, { files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26" }) } });
    await service.add(REPO);
    await service.browse(REPO, false);
    const hold = deferred();
    github.beforeTheme = () => hold.promise;
    const install = service.install({ repository: REPO, commit: C1, path: "dusk.json" });
    await vi.waitFor(() => expect(github.calls.at(-1)).toContain("/dusk.json"));
    await service.remove(REPO);
    hold.resolve();
    expect(await install).toMatchObject({ ok: false, message: "add the repository first" });
    expect(registry.getSetting("storedThemes")).toEqual([]);
  });

  it("refuses an official install that finishes after a disable queued behind another save", async () => {
    const saving = deferred();
    let holdBroadcast = true;
    const { registry, service, github, themes } = setup(() => 0, OFFICIAL, () =>
      holdBroadcast ? saving.promise : Promise.resolve(),
    );
    github.commits.set(C1, { files: { "dusk.json": themeFile({ label: "Dusk", canvas: "#1a1b26" }) } });
    await service.browse(OFFICIAL, false);
    const download = deferred();
    github.beforeTheme = () => download.promise;
    const install = service.install({ repository: OFFICIAL, commit: C1, path: "dusk.json" });
    await vi.waitFor(() => expect(github.calls.at(-1)).toContain("/dusk.json"));
    // A save holds the queue; the disable queues behind it; then the download finishes.
    const pending = saveStoredTheme(themes, { label: "Mine", seeds: { canvas: "#16161e" }, backdrop: null });
    const disable = setOfficialThemes(themes, false);
    download.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.getSetting("officialThemes")).toBe(true);
    holdBroadcast = false;
    saving.resolve();
    await Promise.all([pending, disable]);
    expect(await install).toMatchObject({ ok: false, message: "add the repository first" });
    expect(registry.getSetting("storedThemes").map((t) => t.label)).toEqual(["Mine"]);
  });
});
