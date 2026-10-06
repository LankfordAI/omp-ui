import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObsidianListEntry, RootGuard, VaultRegistry } from "@omp-ui/core";
import { openVaultTarget } from "./vault-open";

let vaultsBase: string;
let guardBase: string;
let guard: RootGuard;
let vaultReal: string;
let opened: string[];

beforeEach(() => {
  // The vault and the guard roots live in different temp dirs, so the vault is never inside a guarded root.
  vaultsBase = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-open-"));
  guardBase = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-guard-"));
  guard = {
    home: path.join(guardBase, "home"),
    userData: path.join(guardBase, "userData"),
    agentDir: path.join(guardBase, "agent"),
    sessionsRoot: path.join(guardBase, "sessions"),
    archiveRoot: path.join(guardBase, "archive"),
  };
  for (const dir of Object.values(guard)) fs.mkdirSync(dir, { recursive: true });
  const vault = path.join(vaultsBase, "Vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(vault, "omp-ui", "folder.md"), { recursive: true });
  fs.writeFileSync(path.join(vault, "omp-ui", "Foo.md"), "# Foo\n");
  fs.writeFileSync(path.join(vault, ".obsidian", "a.md"), "hidden\n");
  fs.writeFileSync(path.join(vault, "note.txt"), "plain\n");
  vaultReal = fs.realpathSync(vault);
  opened = [];
});

afterEach(() => {
  fs.rmSync(vaultsBase, { recursive: true, force: true });
  fs.rmSync(guardBase, { recursive: true, force: true });
});

function registry(vaultPath = path.join(vaultsBase, "Vault")): VaultRegistry {
  return {
    vaults: [{ name: "Vault", path: vaultPath, homeFolder: "omp-ui/", allowWritesOutsideHome: false }],
    defaultWriteVault: "Vault",
  };
}

function deps(list: ObsidianListEntry[] = []) {
  return {
    guard,
    obsidianList: async () => list,
    open: async (uri: string) => {
      opened.push(uri);
    },
  };
}

describe("openVaultTarget", () => {
  it("rejects an unknown vault name", async () => {
    await expect(openVaultTarget(registry(), "x", null, deps())).rejects.toThrow('unknown vault "x"');
    expect(opened).toEqual([]);
  });

  it("re-validates the root at call time and refuses a folder swapped for a link to home", async () => {
    const swapped = path.join(vaultsBase, "Swapped");
    fs.mkdirSync(swapped);
    const reg = registry(swapped);
    reg.vaults[0]!.name = "Swapped";
    fs.rmSync(swapped, { recursive: true });
    fs.symlinkSync(guard.home, swapped, "dir");
    await expect(openVaultTarget(reg, "Swapped", null, deps())).rejects.toThrow(
      `omp-ui cannot use ${fs.realpathSync(guard.home)} as a vault: it is your home directory`,
    );
    expect(opened).toEqual([]);
  });

  it.each([
    ["../x.md"],
    [".obsidian/a.md"],
    ["omp-ui/Missing.md"],
    ["omp-ui/folder.md"],
    ["note.txt"],
  ])("rejects file %s without opening anything", async (file) => {
    await expect(openVaultTarget(registry(), "Vault", file, deps())).rejects.toThrow();
    expect(opened).toEqual([]);
  });

  it("names the missing note", async () => {
    await expect(openVaultTarget(registry(), "Vault", "omp-ui/Missing.md", deps())).rejects.toThrow(
      "note not found: omp-ui/Missing.md",
    );
  });

  it("opens a listed vault by its Obsidian id with the extension stripped", async () => {
    const list = [{ id: "ee8bdab8baa42089", path: vaultReal, open: false }];
    await openVaultTarget(registry(), "Vault", "omp-ui/Foo.md", deps(list));
    expect(opened).toEqual(["obsidian://open?vault=ee8bdab8baa42089&file=omp-ui%2FFoo"]);
  });

  it("opens an unlisted vault by its absolute note path", async () => {
    await openVaultTarget(registry(), "Vault", "omp-ui/Foo.md", deps());
    expect(opened).toEqual([
      `obsidian://open?path=${encodeURIComponent(path.join(vaultReal, "omp-ui", "Foo.md"))}`,
    ]);
  });

  it("opens the vault root when file is null", async () => {
    const list = [{ id: "ee8bdab8baa42089", path: vaultReal, open: true }];
    await openVaultTarget(registry(), "Vault", null, deps(list));
    expect(opened).toEqual(["obsidian://open?vault=ee8bdab8baa42089"]);
  });

  it("opens an unlisted vault root by its path", async () => {
    await openVaultTarget(registry(), "Vault", null, deps());
    expect(opened).toEqual([`obsidian://open?path=${encodeURIComponent(vaultReal)}`]);
  });
});
