import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, Registry, type CouncilDocument, type ModelCatalogSnapshot } from "@omp-ui/core";
import { seedRegistry } from "./test/fixtures";

/**
 * The boot-time council roster seed (graduation, amends #1055): an never-
 * authored global document seeds once from favorites; anything the user ever
 * saved — even an empty document — is untouchable, and every catalog failure
 * writes nothing so the next boot retries.
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

// A scripted chat catalog: unit-level suggestion semantics live in
// packages/core/src/council-config.test.ts; what is owned here is the
// null-document gate, the discovery gate, and the round-trip re-read.
const readModelCatalog = vi.hoisted(() => vi.fn<(arg: { ompPath: string | null }) => Promise<ModelCatalogSnapshot>>());
vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omp-ui/core")>();
  return {
    ...core,
    resolveOmpBinary: () => "/x/omp",
    readModelCatalog,
  };
});

// Why dynamic: ./backend must load only after the vi.mock factories above are
// registered, exactly like the other main-process backend tests.
const { MainBackend } = await import("./backend");
type MainBackendType = InstanceType<typeof MainBackend>;

const win = {
  isDestroyed: () => false,
  webContents: { mainFrame: {}, isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};

let base: string;
let registryFile: string;

function catalog(...models: Array<[string, string]>): ModelCatalogSnapshot {
  return {
    models: models.map(([provider, id]) => ({ provider, id, name: id })),
    discovered: true,
    error: null,
  };
}

const undiscovered: ModelCatalogSnapshot = { models: [], discovered: false, error: "no omp" };

/** One boot: seed favorites/roster/councilEnabled as given, build the backend. */
function boot(patch: {
  favorites?: string[];
  roster?: CouncilDocument | null;
  councilEnabled?: boolean;
}): MainBackendType {
  seedRegistry(registryFile, {
    settings: {
      modelFavorites: patch.favorites ?? [],
      councilRoster: patch.roster === undefined ? null : patch.roster,
      councilEnabled: patch.councilEnabled ?? true,
    },
  });
  handlers.clear();
  const be: MainBackendType = new MainBackend(win as never, registryFile, {
    logDir: path.join(base, "logs"),
  });
  be.registerIpc();
  return be;
}

function persistedRoster(): CouncilDocument | null {
  return Registry.load(registryFile).getSetting("councilRoster");
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args));

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-councilseed-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  registryFile = path.join(base, "registry.json");
  readModelCatalog.mockReset();
  readModelCatalog.mockResolvedValue(undiscovered);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("seedCouncilRosterIfUnset", () => {
  it("seeds an unauthored document from favorites, in order, deduped and capped at 3, with blank names", async () => {
    const be = boot({ favorites: ["b/two:high", "a/one", "b/two", "c/three", "d/four"] });
    readModelCatalog.mockResolvedValue(catalog(["a", "one"], ["b", "two"], ["c", "three"], ["d", "four"]));
    await be.seedCouncilRosterIfUnset();
    const roster = persistedRoster();
    expect(roster).not.toBeNull();
    expect(roster?.instructions).toBeNull();
    // Favorites order wins; the `:high` favorite dedupes with the bare one;
    // MAX_COUNCIL_MEMBERS (3) truncates. Blank names keep following the model (#1057).
    expect(roster?.members.map((m) => m.model)).toEqual(["b/two", "a/one", "c/three"]);
    expect(roster?.members.every((m) => m.name === "" && m.enabled && m.instructions === null)).toBe(true);
  });

  it("never reads the catalog once any global document exists, even an empty or all-disabled one", async () => {
    for (const roster of [
      { instructions: null, members: [] },
      {
        instructions: "custom",
        members: [{ name: "old", model: "z/zero", instructions: null, enabled: false }],
      },
    ] as CouncilDocument[]) {
      const be = boot({ favorites: ["a/one"], roster });
      readModelCatalog.mockResolvedValue(catalog(["a", "one"]));
      await be.seedCouncilRosterIfUnset();
      expect(readModelCatalog).not.toHaveBeenCalled();
      expect(persistedRoster()).toEqual(roster);
    }
  });

  it("writes nothing on an undiscovered catalog or a favorites miss, and seeds on a later retry", async () => {
    const be = boot({ favorites: ["a/one"] });
    await be.seedCouncilRosterIfUnset();
    expect(persistedRoster()).toBeNull();
    // Favorites that no longer resolve in the catalog also write nothing.
    readModelCatalog.mockResolvedValue(catalog(["z", "other"]));
    await be.seedCouncilRosterIfUnset();
    expect(persistedRoster()).toBeNull();
    // The retry with a recovered catalog: seeding is not one-shot like the
    // memory marker — the null document itself is the gate.
    readModelCatalog.mockResolvedValue(catalog(["a", "one"]));
    await be.seedCouncilRosterIfUnset();
    expect(persistedRoster()?.members.map((m) => m.model)).toEqual(["a/one"]);
  });

  it("lets a roster authored during the catalog round trip win (re-read guard)", async () => {
    const be = boot({ favorites: ["a/one"] });
    let settle!: (value: ModelCatalogSnapshot) => void;
    readModelCatalog.mockReturnValue(
      new Promise<ModelCatalogSnapshot>((resolve) => {
        settle = resolve;
      }),
    );
    const seeding = be.seedCouncilRosterIfUnset();
    // The user authors their roster in the editor while the probe is in flight.
    const authored: CouncilDocument = {
      instructions: "mine",
      members: [{ name: "Pick", model: "p/picked", instructions: null, enabled: true }],
    };
    await invoke(CH.setCouncilRoster, { scopeCwd: null, scope: "user", document: authored });
    settle(catalog(["a", "one"]));
    await seeding;
    expect(persistedRoster()).toEqual(authored);
  });

  it("exposes the boot gate the index.ts chain consults (councilEnabled)", () => {
    expect(boot({ councilEnabled: true }).isCouncilEnabled()).toBe(true);
    expect(boot({ councilEnabled: false }).isCouncilEnabled()).toBe(false);
  });
});
