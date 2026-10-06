import * as fs from "node:fs/promises";
import {
  buildVaultOpenUri,
  resolveVaultPath,
  validateVaultRoot,
  type ObsidianListEntry,
  type RootGuard,
  type VaultRegistry,
} from "@omp-ui/core";

/**
 * Hands a registry-built obsidian:// URI to the OS. The caller supplies only a
 * registry name and a vault-relative note path; the root is re-validated at
 * call time. Rejects with a user-facing message (spec 6.5).
 */
export async function openVaultTarget(
  reg: VaultRegistry,
  name: string,
  file: string | null,
  deps: {
    guard: RootGuard;
    obsidianList: () => Promise<ObsidianListEntry[]>;
    open: (uri: string) => Promise<void>;
  },
): Promise<void> {
  const entry = reg.vaults.find((v) => v.name === name);
  if (entry === undefined) throw new Error(`unknown vault "${name}"`);
  const root = await validateVaultRoot(entry.path, deps.guard);
  if (!root.ok) throw new Error(root.reason);
  let rel: string | null = null;
  if (file !== null) {
    const target = await resolveVaultPath(root.real, file);
    if (!target.ok) throw new Error(target.reason);
    const st = await fs.stat(target.abs).catch(() => null);
    if (st === null || !st.isFile() || !/\.md$/i.test(target.abs)) {
      throw new Error(`note not found: ${file}`);
    }
    rel = target.rel;
  }
  await deps.open(buildVaultOpenUri(root.real, rel, await deps.obsidianList()));
}
