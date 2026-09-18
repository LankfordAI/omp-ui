import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedRegistry } from "./test/fixtures";

/**
 * The boot-time memory-default seed (issue #570): the marker gates the core
 * seed, and only a fully successful pass persists it.
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

// A bundled-binary stand-in plus a scripted core seed: the unit-level seed
// behaviour is proven in packages/core/src/memory-defaults.test.ts; what is
// owned here is the marker gate and its persistence.
const seedMemoryDefaults = vi.hoisted(() => vi.fn<(ompPath: string | null) => Promise<boolean>>());
vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omp-ui/core")>();
  return {
    ...core,
    resolveOmpBinary: () => "/x/omp",
    seedMemoryDefaults,
  };
});

// Why dynamic: ./backend must load only after the vi.mock factories above are
// registered, exactly like the other main-process backend tests.
const { MainBackend } = await import("./backend");
type MainBackendType = InstanceType<typeof MainBackend>;

const win = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};

let base: string;
let registryFile: string;

/** One boot: seed the registry as `memoryDefaultsSeeded` says, build the backend. */
function boot(seeded: boolean): MainBackendType {
  seedRegistry(registryFile, { settings: { memoryDefaultsSeeded: seeded } });
  handlers.clear();
  const be: MainBackendType = new MainBackend(win as never, registryFile, {
    logDir: path.join(base, "logs"),
  });
  be.registerIpc();
  return be;
}

function persistedMarker(): unknown {
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    settings: { memoryDefaultsSeeded?: boolean };
  };
  return raw.settings.memoryDefaultsSeeded;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-memseed-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  registryFile = path.join(base, "registry.json");
  seedMemoryDefaults.mockReset();
  seedMemoryDefaults.mockResolvedValue(true);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("seedMemoryDefaultsOnce", () => {
  it("seeds on the first boot and persists the marker", async () => {
    const be = boot(false);
    await be.seedMemoryDefaultsOnce();
    expect(seedMemoryDefaults).toHaveBeenCalledTimes(1);
    expect(seedMemoryDefaults).toHaveBeenCalledWith("/x/omp");
    expect(persistedMarker()).toBe(true);
  });

  it("never calls the core seed once the marker is set", async () => {
    const be = boot(true);
    // A second boot with the marker already true: zero work, zero writes.
    await be.seedMemoryDefaultsOnce();
    expect(seedMemoryDefaults).not.toHaveBeenCalled();
  });

  it("leaves the marker unset when the pass fails, so the next boot retries", async () => {
    const be = boot(false);
    seedMemoryDefaults.mockResolvedValue(false);
    await be.seedMemoryDefaultsOnce();
    expect(persistedMarker()).toBe(false);
    // The retry: with the pass now succeeding, the marker lands.
    seedMemoryDefaults.mockResolvedValue(true);
    await be.seedMemoryDefaultsOnce();
    expect(seedMemoryDefaults).toHaveBeenCalledTimes(2);
    expect(persistedMarker()).toBe(true);
  });
});
