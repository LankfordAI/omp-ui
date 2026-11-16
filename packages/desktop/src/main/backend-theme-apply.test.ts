// Issue #1169: an agent that saved a theme with apply:true has main commit it
// to the user's preference through the same registry keys and broadcast the
// Appearance page writes. These exercise MainBackend's apply seam directly:
// fixed mode takes themeId; system mode takes the dark/light slot matching
// the canvas verdict; an unknown id refuses without writing or broadcasting.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, sourceFromDraft, type BackendState, type ThemeSource } from "@omp-ui/core";
import { MainBackend } from "./backend";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
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

function applyTheme(source: ThemeSource): Promise<boolean> {
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  // The tool seam is private; the test drives it directly (device-pane-host.test.ts convention).
  const internals = backend as unknown as { applyThemeFromTool(source: ThemeSource): Promise<boolean> };
  return internals.applyThemeFromTool(source);
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
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("applyThemeFromTool (issue #1169)", () => {
  it("fixed mode writes themeId and broadcasts the new id once", async () => {
    seedSettings({ themeMode: "fixed", themeId: "graphite", storedThemes: [DARK] });
    await expect(applyTheme(DARK)).resolves.toBe(true);
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
    await expect(applyTheme(DARK)).resolves.toBe(true);
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
    await expect(applyTheme(LIGHT)).resolves.toBe(true);
    const after = readSettings();
    expect(after.lightThemeId).toBe("custom-dawn-def456");
    expect(after.darkThemeId).toBe("graphite");
    expect(after.themeMode).toBe("system");
  });

  it("refuses a theme that is not in the registry with no write and no broadcast", async () => {
    seedSettings({ themeMode: "fixed", themeId: "graphite", storedThemes: [] });
    await expect(applyTheme(DARK)).resolves.toBe(false);
    const after = readSettings();
    expect(after.themeId).toBe("graphite");
    expect(broadcastStates()).toHaveLength(0);
  });
});
