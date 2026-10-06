import type { VaultAction } from "@omp-ui/core/vault-shared";
import type { RenderItem } from "./transcript";

/** The four vault actions that change a note; the card and the rail list only these. */
export type VaultWriteAction = Extract<VaultAction, "create" | "append" | "edit" | "link">;

export function isVaultWriteAction(action: VaultAction): action is VaultWriteAction {
  return action === "create" || action === "append" || action === "edit" || action === "link";
}

/** A vault-relative note path's display title: its basename without ".md". */
export function noteTitleFromPath(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

/** One row of the rail's "Vault notes" (CONTEXT.md "Vault note"). */
export interface TouchedVaultNote {
  vaultName: string;
  vaultId: string | null;
  path: string;
  title: string;
  action: VaultWriteAction;
  /** The transcript item to scroll to: the latest write of this note. */
  itemId: string;
  createdByOmpUi: boolean | null;
}

/**
 * The Vault notes a transcript touched (#759: derived, never sent). Only settled
 * ("done") tool items whose details parsed and name a write action count. Keyed
 * by vault + path; the latest action wins while the row keeps its first-touch
 * position (Map.set on an existing key keeps insertion order). A create that
 * updated an Index note also touches that note as an omp-ui edit.
 */
export function touchedVaultNotes(items: RenderItem[]): TouchedVaultNote[] {
  const byKey = new Map<string, TouchedVaultNote>();
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "done") continue;
    const vault = item.vault;
    if (vault === undefined || vault.path === null || !isVaultWriteAction(vault.action)) continue;
    byKey.set(`${vault.vaultName}\u0000${vault.path}`, {
      vaultName: vault.vaultName,
      vaultId: vault.vaultId,
      path: vault.path,
      title: vault.title ?? noteTitleFromPath(vault.path),
      action: vault.action,
      itemId: item.id,
      createdByOmpUi: vault.createdByOmpUi,
    });
    if (vault.action === "create" && vault.indexNotePath !== undefined) {
      byKey.set(`${vault.vaultName}\u0000${vault.indexNotePath}`, {
        vaultName: vault.vaultName,
        vaultId: vault.vaultId,
        path: vault.indexNotePath,
        title: noteTitleFromPath(vault.indexNotePath),
        action: "edit",
        itemId: item.id,
        createdByOmpUi: true,
      });
    }
  }
  return [...byKey.values()];
}
