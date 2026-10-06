import { useState } from "react";
import type { VaultDetection } from "@omp-ui/core/types";
import { vaultNameFromPath } from "@omp-ui/core/vault-shared";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { Button, Chip, Modal } from "../ui";

/**
 * Import from Obsidian's own vault list (obsidian.json, issue #764). Rows
 * already in the Vault registry stay checked, disabled, and chipped "added".
 * Main re-reads the list and skips ids it cannot add; the dialog closes either
 * way and the registry broadcast refreshes the page.
 */
export function VaultImportDialog({
  entries,
  onClose,
}: {
  entries: VaultDetection["obsidianList"];
  onClose: () => void;
}) {
  const t = useT();
  const importVaults = useStore((s) => s.importVaults);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const picks = entries.filter((entry) => entry.registeredAs === null && selected.has(entry.id));

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runImport = async (): Promise<void> => {
    await importVaults(picks.map((entry) => entry.id));
    onClose();
  };

  return (
    <Modal onClose={onClose} width="w-[30rem]" labelledBy="vault-import-title">
      <header className="border-b border-line px-4 py-3">
        <h2 id="vault-import-title" className="font-display text-sm font-semibold text-ink">
          {t("settings.vault.importTitle")}
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.vault.importHint")}</p>
      </header>

      <div className="max-h-[22rem] overflow-y-auto px-2 py-2">
        <ul className="space-y-px">
          {entries.map((entry) => {
            const added = entry.registeredAs !== null;
            return (
              <li key={entry.id}>
                <label className="flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover has-[:disabled]:cursor-default has-[:disabled]:hover:bg-transparent">
                  <input
                    type="checkbox"
                    checked={added || selected.has(entry.id)}
                    disabled={added}
                    onChange={() => toggle(entry.id)}
                    className="mt-0.5 size-3.5 shrink-0 accent-current"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-ink">{vaultNameFromPath(entry.path)}</span>
                      <span className="font-mono text-[10px] text-ink-faint">{entry.id}</span>
                      {entry.open && <Chip>{t("settings.vault.open")}</Chip>}
                      {added && <Chip tone="signal">{t("settings.vault.added")}</Chip>}
                    </span>
                    <span className="block break-all font-mono text-[11px] text-ink-dim">{entry.path}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2.5">
        <Button variant="ghost" onClick={onClose}>
          {t("settings.vault.importCancel")}
        </Button>
        <Button variant="solid" disabled={picks.length === 0} onClick={() => void runImport()}>
          {t("settings.vault.importConfirm")}
        </Button>
      </footer>
    </Modal>
  );
}
