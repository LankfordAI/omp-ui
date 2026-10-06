import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CH, Registry, type ObsidianList, type RootGuard, type VaultDetection } from "@omp-ui/core";
import { registerVaultHandlers } from "./vault-handlers";

let registryDir: string;
let registryFile: string;
let vaultsBase: string;
let guardBase: string;
let guard: RootGuard;
let registry: Registry;
let broadcasts: number;
let opened: string[];
let obsidianList: ObsidianList | null;

const detection: VaultDetection = {
  obsidianListFile: null,
  obsidianList: [],
  cliRegistered: false,
  uriHandler: false,
  rows: {},
};

beforeEach(() => {
  // Registry (the guard's userData), vaults and the other guard roots each get their own temp dir.
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-reg-"));
  registryFile = path.join(registryDir, "registry.json");
  vaultsBase = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vaults-"));
  guardBase = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-guard-"));
  guard = {
    home: path.join(guardBase, "home"),
    userData: registryDir,
    agentDir: path.join(guardBase, "agent"),
    sessionsRoot: path.join(guardBase, "sessions"),
    archiveRoot: path.join(guardBase, "archive"),
  };
  fs.mkdirSync(guard.home);
  fs.mkdirSync(path.join(vaultsBase, "A"));
  fs.mkdirSync(path.join(vaultsBase, "other", "A"), { recursive: true });
  registry = Registry.load(registryFile);
  broadcasts = 0;
  opened = [];
  obsidianList = null;
});

afterEach(() => {
  fs.rmSync(registryDir, { recursive: true, force: true });
  fs.rmSync(vaultsBase, { recursive: true, force: true });
  fs.rmSync(guardBase, { recursive: true, force: true });
});

function handlers() {
  return registerVaultHandlers({
    registry,
    broadcast: async () => {
      broadcasts += 1;
    },
    guard: () => guard,
    detect: async () => detection,
    obsidianList: async () => obsidianList,
    open: async (uri) => {
      opened.push(uri);
    },
  });
}

/** registry.json as written to disk; null before the first write. */
function onDisk(): string | null {
  return fs.existsSync(registryFile) ? fs.readFileSync(registryFile, "utf8") : null;
}

describe("vault handlers", () => {
  it("detectVaults answers from the injected detection", async () => {
    await expect(handlers()[CH.detectVaults]()).resolves.toBe(detection);
  });

  it("addVault stores the resolved path, writes, and broadcasts once", async () => {
    const a = path.join(vaultsBase, "A");
    await handlers()[CH.addVault](`${vaultsBase}/other/../A/`);
    const expected = {
      vaults: [{ name: "A", path: a, homeFolder: "omp-ui/", allowWritesOutsideHome: false }],
      defaultWriteVault: "A",
    };
    expect(registry.getSetting("vaultRegistry")).toEqual(expected);
    expect(Registry.load(registryFile).getSetting("vaultRegistry")).toEqual(expected);
    expect(broadcasts).toBe(1);
  });

  it("addVault refuses the guard's home without writing or broadcasting", async () => {
    const before = onDisk();
    await expect(handlers()[CH.addVault](guard.home)).rejects.toThrow(
      `omp-ui cannot use ${fs.realpathSync.native(guard.home)} as a vault: it is your home directory`,
    );
    expect(onDisk()).toBe(before);
    expect(registry.getSetting("vaultRegistry").vaults).toEqual([]);
    expect(broadcasts).toBe(0);
  });

  it("addVault rejects a missing folder with resolveProjectPath's message", async () => {
    const gone = path.join(vaultsBase, "Gone");
    await expect(handlers()[CH.addVault](gone)).rejects.toThrow(`no such directory: ${gone}`);
    expect(broadcasts).toBe(0);
  });

  it("addVault rejects a duplicate basename", async () => {
    const h = handlers();
    await h[CH.addVault](path.join(vaultsBase, "A"));
    const before = onDisk();
    await expect(h[CH.addVault](path.join(vaultsBase, "other", "A"))).rejects.toThrow(
      "A vault named A is already registered.",
    );
    expect(onDisk()).toBe(before);
    expect(broadcasts).toBe(1);
  });

  it("importVaults adds known ids and skips unknown, refused and duplicate ones, broadcasting once", async () => {
    obsidianList = {
      file: path.join(guardBase, "obsidian.json"),
      cli: false,
      vaults: [
        { id: "a1", path: fs.realpathSync.native(path.join(vaultsBase, "A")), open: false },
        { id: "home1", path: fs.realpathSync.native(guard.home), open: false },
        { id: "dup1", path: fs.realpathSync.native(path.join(vaultsBase, "other", "A")), open: false },
      ],
    };
    await expect(handlers()[CH.importVaults](["a1", "unknown1", "home1", "dup1"])).resolves.toEqual({
      added: ["A"],
      skipped: ["unknown1", "home1", "dup1"],
    });
    const stored = Registry.load(registryFile).getSetting("vaultRegistry");
    expect(stored.vaults.map((v) => v.name)).toEqual(["A"]);
    expect(stored.defaultWriteVault).toBe("A");
    expect(broadcasts).toBe(1);
  });

  it("importVaults with nothing added neither writes nor broadcasts", async () => {
    obsidianList = {
      file: path.join(guardBase, "obsidian.json"),
      cli: false,
      vaults: [{ id: "home1", path: fs.realpathSync.native(guard.home), open: false }],
    };
    const before = onDisk();
    await expect(handlers()[CH.importVaults](["unknown1", "home1"])).resolves.toEqual({
      added: [],
      skipped: ["unknown1", "home1"],
    });
    expect(onDisk()).toBe(before);
    expect(broadcasts).toBe(0);
  });

  it("setVaultHomeFolder refuses a path that leaves the vault", async () => {
    const h = handlers();
    await h[CH.addVault](path.join(vaultsBase, "A"));
    const before = onDisk();
    await expect(h[CH.setVaultHomeFolder]("A", "../x")).rejects.toThrow(
      "Use a folder inside the vault, like omp-ui/.",
    );
    expect(onDisk()).toBe(before);
    expect(broadcasts).toBe(1);
  });

  it("the row setters commit through the registry", async () => {
    const h = handlers();
    await h[CH.addVault](path.join(vaultsBase, "A"));
    await h[CH.addVault](path.join(vaultsBase, "other"));
    await h[CH.setDefaultWriteVault]("other");
    await h[CH.setVaultHomeFolder]("A", " notes\\omp ");
    await h[CH.setVaultWritesOutsideHome]("A", true);
    expect(registry.getSetting("vaultRegistry")).toEqual({
      vaults: [
        { name: "A", path: path.join(vaultsBase, "A"), homeFolder: "notes/omp/", allowWritesOutsideHome: true },
        { name: "other", path: path.join(vaultsBase, "other"), homeFolder: "omp-ui/", allowWritesOutsideHome: false },
      ],
      defaultWriteVault: "other",
    });
    await h[CH.removeVault]("other");
    expect(registry.getSetting("vaultRegistry").defaultWriteVault).toBe("A");
    await expect(h[CH.removeVault]("nope")).rejects.toThrow('unknown vault "nope"');
    expect(broadcasts).toBe(6);
  });

  it("openVault builds the URI from the registry row", async () => {
    const h = handlers();
    await h[CH.addVault](path.join(vaultsBase, "A"));
    obsidianList = {
      file: path.join(guardBase, "obsidian.json"),
      cli: false,
      vaults: [{ id: "a1", path: fs.realpathSync.native(path.join(vaultsBase, "A")), open: false }],
    };
    await h[CH.openVault]("A", null);
    expect(opened).toEqual(["obsidian://open?vault=a1"]);
  });

  it("vaultNames answers registry names in registry order", async () => {
    const h = handlers();
    await expect(h[CH.vaultNames]()).resolves.toEqual([]);
    await h[CH.addVault](path.join(vaultsBase, "other"));
    await h[CH.addVault](path.join(vaultsBase, "A"));
    await expect(h[CH.vaultNames]()).resolves.toEqual(["other", "A"]);
  });
});
