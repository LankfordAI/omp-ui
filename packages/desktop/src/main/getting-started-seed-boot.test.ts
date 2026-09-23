import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectRecord } from "@omp-ui/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

/**
 * The boot-time Getting started seed (issue #623): a registry that already
 * carries a life — projects or sessions — is not a first install, so its
 * first boot of this build marks the checklist seen and the upgrade never
 * pops it. An empty-life registry keeps the flag false exactly like a fresh
 * install does.
 */

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {},
  },
}));

// Why dynamic: ./backend must load only after the vi.mock factory above is
// registered, exactly like the other main-process backend tests.
const { MainBackend } = await import("./backend");

const win = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};

const PROJECT: ProjectRecord = {
  path: "/proj",
  name: "proj",
  addedAt: "2026-09-01T00:00:00.000Z",
  lastModel: null,
  lastThinkingLevel: null,
  lastAdvisor: null,
  lastAdvisorModel: null,
  defaultModel: null,
  defaultAdvisorModel: null,
  browserClock: false,
};

let base: string;
let registryFile: string;
function makeBackend(): void {
  handlers.clear();
  new MainBackend(win as never, registryFile, {
    logDir: path.join(base, "logs"),
  }).registerIpc();
}

/** Seed the registry file fresh, then boot once on top of it. */
function boot(patch: Parameters<typeof seedRegistry>[1] = {}): void {
  seedRegistry(registryFile, patch);
  makeBackend();
}

function persistedFlag(): unknown {
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    settings: { gettingStartedSeen?: boolean };
  };
  return raw.settings.gettingStartedSeen;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-gsseed-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  registryFile = path.join(base, "registry.json");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("getting-started boot seed", () => {
  it("marks a registry that carries projects as seen", () => {
    boot({ projects: [PROJECT] });
    expect(persistedFlag()).toBe(true);
  });

  it("marks a registry that carries sessions as seen", () => {
    boot({ sessions: [ownedSessionRecord()] });
    expect(persistedFlag()).toBe(true);
  });

  it("leaves an empty-life registry unseen — the fresh-install path", () => {
    boot();
    expect(persistedFlag()).toBe(false);
  });

  it("seeds once: a later boot never re-runs the write", () => {
    boot({ projects: [PROJECT] });
    expect(persistedFlag()).toBe(true);
    // The mint one-shots have run and the flag is already true: the next
    // boot writes nothing at all, so a user who later removes every project
    // keeps the persisted true and stays quiet.
    const bytes = fs.readFileSync(registryFile, "utf8");
    makeBackend();
    expect(fs.readFileSync(registryFile, "utf8")).toBe(bytes);
  });
});
