import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderKeysSnapshot } from "@omp-ui/core";
import { seedRegistry } from "./test/fixtures";

/**
 * The provider-key IPC surface: what the settings page can actually do, and the
 * guarantee that key material never crosses the boundary to reach it.
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

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const { electronKeyCipher } = await import("./key-cipher");

const win = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: () => {} },
};

const KEY = "OPENROUTER_API_KEY";
const VALUE = "sk-or-v1-0123456789abcdef";

let base: string;
let keysFile: string;

function setup(): void {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-provkeys-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env[KEY];

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile);
  keysFile = path.join(base, "provider-keys.json");

  handlers.clear();
  new MainBackend(win as never, registryFile, { providerKeysFile: keysFile }).registerIpc();
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);
const snapshot = (result: unknown): ProviderKeysSnapshot => result as ProviderKeysSnapshot;
const row = (snap: ProviderKeysSnapshot, id: string) => {
  const found = snap.providers.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no such provider row: ${id}`);
  return found;
};

beforeEach(setup);

afterEach(() => {
  delete process.env[KEY];
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("provider-keys IPC", () => {
  it("reads every catalogued provider, unconfigured, with no key material", () => {
    const snap = snapshot(invoke(CH.readProviderKeys, null));
    expect(snap.providers.length).toBeGreaterThan(10);
    expect(row(snap, "openrouter")).toMatchObject({ source: "none", masked: null });
    expect(snap.encryptionAvailable).toBe(true);
    expect(snap.backend).toBe(process.platform === "win32" ? "windows-dpapi" : "test_stub");
  });

  it("a saved key reaches the environment omp inherits — the whole point", () => {
    invoke(CH.setProviderKey, KEY, VALUE);
    expect(process.env[KEY]).toBe(VALUE);
  });

  it("answers a write with the refreshed snapshot, so no re-read is needed", () => {
    const snap = snapshot(invoke(CH.setProviderKey, KEY, VALUE));
    expect(row(snap, "openrouter")).toMatchObject({ source: "stored", masked: "••••cdef" });
  });

  it("never returns the key itself over IPC, only a masked tail", () => {
    const snap = snapshot(invoke(CH.setProviderKey, KEY, VALUE));
    expect(JSON.stringify(snap)).not.toContain(VALUE);
  });

  it("clearing removes the key from the environment and the store", () => {
    invoke(CH.setProviderKey, KEY, VALUE);
    const snap = snapshot(invoke(CH.clearProviderKey, KEY));
    expect(KEY in process.env).toBe(false);
    expect(row(snap, "openrouter").source).toBe("none");
  });

  it("survives a restart: a stored key is applied before any session can spawn", () => {
    invoke(CH.setProviderKey, KEY, VALUE);
    delete process.env[KEY];
    // A fresh backend is exactly what the next app launch builds.
    new MainBackend(win as never, path.join(base, "registry.json"), {
      providerKeysFile: keysFile,
    });
    expect(process.env[KEY]).toBe(VALUE);
  });

  it("rejects a variable outside the provider catalog", () => {
    expect(() => invoke(CH.setProviderKey, "LD_PRELOAD", "/tmp/evil.so")).toThrow(
      /unknown provider variable/,
    );
  });

  it("reports a project .env key without injecting it — omp loads those itself", () => {
    const project = path.join(base, "proj");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, ".env"), `${KEY}=${VALUE}\n`);
    const snap = snapshot(invoke(CH.readProviderKeys, project));
    expect(row(snap, "openrouter").source).toBe("dotenv");
    expect(KEY in process.env).toBe(false);
  });
});

describe("Windows credential backend", () => {
  it("reports DPAPI and round-trips stored provider credentials", () => {
    expect(electronKeyCipher("win32").backend).toBe("windows-dpapi");
    invoke(CH.setProviderKey, KEY, VALUE);
    delete process.env[KEY];
    new MainBackend(win as never, path.join(base, "registry.json"), {
      providerKeysFile: keysFile,
    });
    expect(process.env[KEY]).toBe(VALUE);
    expect(row(snapshot(invoke(CH.readProviderKeys, null)), "openrouter").source).toBe("stored");
  });
});
