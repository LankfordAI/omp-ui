// Issues #1169 and #1175: an agent that saved a theme with apply:true, or that
// calls omp-ui_theme_set, has main commit it to the user's preference through
// the same registry keys and broadcast the Appearance page writes. These
// exercise MainBackend's apply/set/list seams directly: fixed mode takes
// themeId; system mode takes the slot named or matching the canvas verdict;
// an unknown id refuses without writing or broadcasting; painting is reported
// honestly against the stubbed OS scheme.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKDROP_IMAGE_BYTES_MAX,
  BACKDROP_VIDEO_BYTES_MAX,
  CH,
  sourceFromDraft,
  type BackendState,
  type SaveStoredThemeResult,
  type ThemeApplyResult,
  type ThemeList,
  type ThemeSetArgs,
  type ThemeSetOutcome,
  type ThemeSource,
  type ThemeToolArgs,
} from "@omp-ui/core";
import { MainBackend } from "./backend";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
// The scheme omp-ui_theme_set's painting truth reads; tests flip it per case.
const scheme = vi.hoisted(() => ({ dark: true }));

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  nativeTheme: {
    get shouldUseDarkColors() {
      return scheme.dark;
    },
  },
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
  },
}));

vi.mock("@omp-ui/core", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    resolveSessionLocation: vi.fn(async () => ({ where: "missing" })),
    RpcClient: vi.fn(),
    watchLineageDir: vi.fn(() => () => {}),
    watchGitHead: vi.fn(async () => () => {}),
  };
});

const sent: { channel: string; args: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    mainFrame: {},
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base = "";
let registryFile = "";

const DARK = sourceFromDraft("custom-dusk-abc123", "Dusk", { canvas: "#0a0a0a" });
const LIGHT = sourceFromDraft("custom-dawn-def456", "Dawn", { canvas: "#fafafa" });

function seedSettings(patch: Record<string, unknown>): void {
  seedRegistry(registryFile, {
    projects: [],
    sessions: [ownedSessionRecord({ projectCwd: "/p/a" })],
    settings: patch,
  });
}

interface ThemeInternals {
  applyThemeFromTool(source: ThemeSource): Promise<ThemeApplyResult | null>;
  setThemeFromTool(args: ThemeSetArgs): Promise<ThemeSetOutcome>;
  listThemesForTool(): ThemeList;
  saveThemeFromTool(tabId: string, args: ThemeToolArgs): Promise<SaveStoredThemeResult>;
}

function internals(): ThemeInternals {
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  // The tool seams are private; the test drives them directly (device-pane-host.test.ts convention).
  return backend as unknown as ThemeInternals;
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(registryFile, "utf8")).settings as Record<string, unknown>;
}

function broadcastStates(): BackendState[] {
  return sent.filter((event) => event.channel === CH.onStateChanged).map((event) => event.args[0] as BackendState);
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-theme-apply-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  registryFile = path.join(base, "registry.json");
  handlers.clear();
  sent.length = 0;
  scheme.dark = true;
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("applyThemeFromTool (issue #1169)", () => {
  it("fixed mode writes themeId and broadcasts the new id once", async () => {
    seedSettings({ themeMode: "fixed", themeId: "graphite", storedThemes: [DARK] });
    await expect(internals().applyThemeFromTool(DARK)).resolves.toEqual({ slot: "themeId", painting: true });
    const after = readSettings();
    expect(after.themeId).toBe("custom-dusk-abc123");
    expect(after.themeMode).toBe("fixed");
    const states = broadcastStates();
    expect(states.length).toBeGreaterThanOrEqual(1);
    const last = states.at(-1)! as unknown as Record<string, unknown>;
    expect(last.themeId).toBe("custom-dusk-abc123");
  });

  it("system mode with a dark canvas writes darkThemeId and leaves the light pick alone", async () => {
    seedSettings({
      themeMode: "system",
      darkThemeId: "graphite",
      lightThemeId: "paper",
      themeId: "graphite",
      storedThemes: [DARK],
    });
    await expect(internals().applyThemeFromTool(DARK)).resolves.toEqual({ slot: "darkThemeId", painting: true });
    const after = readSettings();
    expect(after.darkThemeId).toBe("custom-dusk-abc123");
    expect(after.lightThemeId).toBe("paper");
    expect(after.themeMode).toBe("system");
  });

  it("system mode with a light canvas writes lightThemeId and leaves the dark pick alone", async () => {
    seedSettings({
      themeMode: "system",
      darkThemeId: "graphite",
      lightThemeId: "paper",
      themeId: "graphite",
      storedThemes: [LIGHT],
    });
    await expect(internals().applyThemeFromTool(LIGHT)).resolves.toEqual({ slot: "lightThemeId", painting: false });
    const after = readSettings();
    expect(after.lightThemeId).toBe("custom-dawn-def456");
    expect(after.darkThemeId).toBe("graphite");
    expect(after.themeMode).toBe("system");
  });

  it("refuses a theme that is not in the registry with no write and no broadcast", async () => {
    seedSettings({ themeMode: "fixed", themeId: "graphite", storedThemes: [] });
    await expect(internals().applyThemeFromTool(DARK)).resolves.toBeNull();
    const after = readSettings();
    expect(after.themeId).toBe("graphite");
    expect(broadcastStates()).toHaveLength(0);
  });
});

describe("setThemeFromTool (issue #1175)", () => {
  it("activates a curated id in fixed mode through themeId", async () => {
    seedSettings({ themeMode: "fixed", themeId: "graphite", storedThemes: [] });
    const outcome = await internals().setThemeFromTool({ id: "nord" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.wrote).toEqual(["themeId"]);
    expect(outcome.list.effectiveLabel).toBe("Nord");
    const after = readSettings();
    expect(after.themeId).toBe("nord");
    expect(broadcastStates()).toHaveLength(1);
  });

  it("system mode with slot auto writes the lightness-matched slot", async () => {
    seedSettings({ themeMode: "system", darkThemeId: "graphite", lightThemeId: "paper", storedThemes: [LIGHT] });
    const outcome = await internals().setThemeFromTool({ id: "custom-dawn-def456" });
    expect(outcome.ok && outcome.wrote).toEqual(["lightThemeId"]);
    expect(readSettings().lightThemeId).toBe("custom-dawn-def456");
    expect(readSettings().darkThemeId).toBe("graphite");
  });

  it("system mode with an explicit slot writes that slot even against lightness, and the list reports painting honestly", async () => {
    // Dark host scheme; a light theme forced into the dark slot paints now.
    seedSettings({ themeMode: "system", darkThemeId: "graphite", lightThemeId: "paper", storedThemes: [LIGHT] });
    const outcome = await internals().setThemeFromTool({ id: "custom-dawn-def456", slot: "dark" });
    expect(outcome.ok && outcome.wrote).toEqual(["darkThemeId"]);
    expect(readSettings().darkThemeId).toBe("custom-dawn-def456");
    if (outcome.ok) expect(outcome.list.scheme).toBe("dark");
  });

  it("refuses an explicit slot under fixed mode without any write or broadcast", async () => {
    seedSettings({ themeMode: "fixed", themeId: "graphite", storedThemes: [LIGHT] });
    const outcome = await internals().setThemeFromTool({ id: "custom-dawn-def456", slot: "light" });
    expect(outcome).toEqual({
      ok: false,
      reason: "slot targets a system-mode pick; with mode fixed the theme needs no slot",
    });
    expect(readSettings().themeId).toBe("graphite");
    expect(broadcastStates()).toHaveLength(0);
  });

  it("refuses an unknown id and lists the valid ids instead of writing", async () => {
    seedSettings({ themeMode: "fixed", themeId: "graphite", storedThemes: [DARK] });
    const outcome = await internals().setThemeFromTool({ id: "n0rd" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("unknown theme id n0rd");
    expect(outcome.reason).toContain("nord — Nord");
    expect(outcome.reason).toContain("custom-dusk-abc123 — Dusk");
    expect(readSettings().themeId).toBe("graphite");
    expect(broadcastStates()).toHaveLength(0);
  });

  it("commits mode and id atomically with one broadcast, and the slot rule keys off the new mode", async () => {
    seedSettings({ themeMode: "system", darkThemeId: "graphite", lightThemeId: "paper", storedThemes: [] });
    // Switching to fixed with an id writes themeId — not a system slot.
    const outcome = await internals().setThemeFromTool({ id: "nord", mode: "fixed" });
    expect(outcome.ok && outcome.wrote).toEqual(["themeId"]);
    if (outcome.ok) expect(outcome.modeChanged).toBe(true);
    const after = readSettings();
    expect(after.themeMode).toBe("fixed");
    expect(after.themeId).toBe("nord");
    // Picks untouched beyond the write.
    expect(after.darkThemeId).toBe("graphite");
    expect(after.lightThemeId).toBe("paper");
    expect(broadcastStates()).toHaveLength(1);
  });

  it("a mode-only flip leaves every pick untouched", async () => {
    seedSettings({ themeMode: "fixed", themeId: "nord", darkThemeId: "graphite", lightThemeId: "paper", storedThemes: [] });
    const outcome = await internals().setThemeFromTool({ mode: "system" });
    expect(outcome.ok && outcome.wrote).toEqual([]);
    if (outcome.ok) expect(outcome.modeChanged).toBe(true);
    const after = readSettings();
    expect(after.themeMode).toBe("system");
    expect(after.themeId).toBe("nord");
  });

  it("a motion-only call flips backdropMotion and nothing else", async () => {
    seedSettings({ themeMode: "fixed", themeId: "graphite", backdropMotion: true, storedThemes: [] });
    const outcome = await internals().setThemeFromTool({ motion: false });
    expect(outcome.ok && outcome.wrote).toEqual([]);
    if (outcome.ok) {
      expect(outcome.motion).toBe(false);
      expect(outcome.modeChanged).toBe(false);
    }
    const after = readSettings();
    expect(after.backdropMotion).toBe(false);
    expect(after.themeId).toBe("graphite");
  });
});

describe("listThemesForTool (issue #1175)", () => {
  it("reports mode, slots, scheme, motion, and every curated plus stored row", async () => {
    seedSettings({ themeMode: "system", darkThemeId: "custom-dusk-abc123", lightThemeId: "paper", storedThemes: [DARK] });
    const list = internals().listThemesForTool();
    expect(list.mode).toBe("system");
    expect(list.scheme).toBe("dark");
    expect(list.motion).toBe(true);
    expect(list.effectiveLabel).toBe("Dusk");
    expect(list.slots).toEqual({ themeId: "graphite", lightThemeId: "paper", darkThemeId: "custom-dusk-abc123" });
    const nord = list.themes.find((t) => t.id === "nord");
    expect(nord).toEqual({ id: "nord", label: "Nord", dark: true, backdrop: false });
    expect(list.themes.find((t) => t.id === "custom-dusk-abc123")).toEqual({
      id: "custom-dusk-abc123",
      label: "Dusk",
      dark: true,
      backdrop: false,
    });
  });

  it("falls back to the raw id for a pick naming a theme that no longer resolves", async () => {
    seedSettings({ themeMode: "fixed", themeId: "ghost-theme", storedThemes: [] });
    const list = internals().listThemesForTool();
    expect(list.effectiveLabel).toBe("ghost-theme");
  });
});

describe("saveThemeFromTool video backdrops", () => {
  const MP4_HEAD = new Uint8Array([
    0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function seedSessionDir(): { cwd: string; tabId: string } {
    const cwd = fs.mkdtempSync(path.join(base, "proj-"));
    const record = ownedSessionRecord({ projectCwd: cwd });
    seedRegistry(registryFile, {
      projects: [],
      sessions: [record],
      settings: { themeMode: "fixed", themeId: "graphite", storedThemes: [] },
    });
    return { cwd, tabId: record.tabId };
  }

  it("accepts a local MP4 larger than 4 MiB and up to 16 MiB", async () => {
    const { cwd, tabId } = seedSessionDir();
    const video = new Uint8Array(BACKDROP_IMAGE_BYTES_MAX + 1024);
    video.set(MP4_HEAD);
    fs.writeFileSync(path.join(cwd, "loop.mp4"), video);
    const result = await internals().saveThemeFromTool(tabId, {
      label: "Ridge",
      seeds: { canvas: "#0a0a0a" },
      backdrop: { path: "loop.mp4", blur: 8 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.backdrop).toMatchObject({ kind: "video", mime: "video/mp4", blur: 8 });
  });

  it("rejects a PNG larger than 4 MiB via checkBackdropBytes", async () => {
    const { cwd, tabId } = seedSessionDir();
    const bigPng = new Uint8Array(BACKDROP_IMAGE_BYTES_MAX + 1);
    bigPng.set(PNG_HEAD);
    fs.writeFileSync(path.join(cwd, "big.png"), bigPng);
    const result = await internals().saveThemeFromTool(tabId, {
      label: "BigPng",
      seeds: { canvas: "#0a0a0a" },
      backdrop: { path: "big.png" },
    });
    expect(result).toEqual({ ok: false, reason: "invalid", message: "image backdrops can be at most 4 MiB" });
  });

  it("rejects an MP4 larger than 16 MiB before reading it", async () => {
    const { cwd, tabId } = seedSessionDir();
    const fd = fs.openSync(path.join(cwd, "huge.mp4"), "w");
    try {
      fs.writeSync(fd, MP4_HEAD, 0, MP4_HEAD.length, 0);
      fs.ftruncateSync(fd, BACKDROP_VIDEO_BYTES_MAX + 1);
    } finally {
      fs.closeSync(fd);
    }
    const result = await internals().saveThemeFromTool(tabId, {
      label: "HugeMp4",
      seeds: { canvas: "#0a0a0a" },
      backdrop: { path: "huge.mp4" },
    });
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      message: "backdrops can be at most 16 MiB (4 MiB for images and scenes)",
    });
  });
});
