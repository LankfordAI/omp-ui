import {
  CH,
  addVaultEntry,
  removeVaultEntry,
  resolveProjectPath,
  setDefaultWriteVault,
  setVaultHomeFolder,
  setVaultWritesOutsideHome,
  validateVaultRoot,
  vaultNameFromPath,
  type ObsidianList,
  type Registry,
  type RequestHandlers,
  type RootGuard,
  type VaultDetection,
  type VaultRegistry,
} from "@omp-ui/core";
import { openVaultTarget } from "./vault-open";

type VaultHandlerChannels =
  | typeof CH.detectVaults
  | typeof CH.addVault
  | typeof CH.importVaults
  | typeof CH.removeVault
  | typeof CH.setDefaultWriteVault
  | typeof CH.setVaultHomeFolder
  | typeof CH.setVaultWritesOutsideHome
  | typeof CH.openVault
  | typeof CH.vaultNames;

interface VaultHandlerDependencies {
  registry: Registry;
  broadcast: () => Promise<void>;
  guard: () => RootGuard;
  detect: () => Promise<VaultDetection>;
  obsidianList: () => Promise<ObsidianList | null>;
  open: (uri: string) => Promise<void>;
}

/**
 * The Vault registry channels (#764). Every transform is pure and throws its
 * user-facing message, so a refused change writes nothing and broadcasts
 * nothing.
 */
export function registerVaultHandlers(
  deps: VaultHandlerDependencies,
): Pick<RequestHandlers, VaultHandlerChannels> {
  const current = (): VaultRegistry => deps.registry.getSetting("vaultRegistry");
  const commit = async (next: VaultRegistry): Promise<void> => {
    deps.registry.setSetting("vaultRegistry", next);
    await deps.broadcast();
  };
  /** Expands ~, requires an existing directory, then applies the root guard (U1). Returns the path to store. */
  const prepare = async (input: string): Promise<string> => {
    const resolved = await resolveProjectPath(input);
    const check = await validateVaultRoot(resolved, deps.guard());
    if (!check.ok) throw new Error(check.reason);
    return resolved;
  };

  return {
    [CH.detectVaults]: () => deps.detect(),
    [CH.addVault]: async (absPath: string) => {
      await commit(addVaultEntry(current(), await prepare(absPath)));
    },
    [CH.importVaults]: async (obsidianIds: string[]) => {
      // Read fresh: the renderer's detection snapshot may be stale.
      const list = (await deps.obsidianList())?.vaults ?? [];
      let reg = current();
      const added: string[] = [];
      const skipped: string[] = [];
      for (const id of obsidianIds) {
        const entry = list.find((v) => v.id === id);
        if (entry === undefined) {
          skipped.push(id);
          continue;
        }
        try {
          const resolved = await prepare(entry.path);
          reg = addVaultEntry(reg, resolved);
          added.push(vaultNameFromPath(resolved));
        } catch {
          skipped.push(id);
        }
      }
      if (added.length > 0) await commit(reg);
      return { added, skipped };
    },
    // async bodies so a throwing transform rejects instead of throwing synchronously.
    [CH.removeVault]: async (name: string) => commit(removeVaultEntry(current(), name)),
    [CH.setDefaultWriteVault]: async (name: string) => commit(setDefaultWriteVault(current(), name)),
    [CH.setVaultHomeFolder]: async (name: string, homeFolder: string) =>
      commit(setVaultHomeFolder(current(), name, homeFolder)),
    [CH.setVaultWritesOutsideHome]: async (name: string, on: boolean) =>
      commit(setVaultWritesOutsideHome(current(), name, on)),
    [CH.openVault]: (name: string, file: string | null) =>
      openVaultTarget(current(), name, file, {
        guard: deps.guard(),
        obsidianList: async () => (await deps.obsidianList())?.vaults ?? [],
        open: deps.open,
      }),
    [CH.vaultNames]: async () => current().vaults.map((row) => row.name),
  };
}
