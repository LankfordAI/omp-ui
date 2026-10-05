// PROTOTYPE (#753): throwaway.
// Import from Obsidian's vault list (obsidian.json, #751). Rows already in the
// registry stay checked, disabled, and tagged "added".
import { useState } from "react";
import { Button, Chip, Empty, Modal } from "../ui";
import { DETECTION } from "./fixtures";
import { addVault, usePrototype753, usePrototypeData, vaultName } from "./state";

export function ImportVaultsDialog({ onClose }: { onClose: () => void }) {
  const proto = usePrototype753();
  const { vaults } = usePrototypeData();
  const list = DETECTION[proto.det].list;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const registered = new Set(vaults.map((v) => v.path.replace(/[/\\]+$/, "")));
  const picks = list.filter((entry) => selected.has(entry.id) && !registered.has(entry.path));

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runImport = (): void => {
    for (const entry of picks) addVault(entry.path, entry.id);
    onClose();
  };

  return (
    <Modal onClose={onClose} width="w-[30rem]" labelledBy="p753-import-title">
      <header className="border-b border-line px-4 py-3">
        <h2 id="p753-import-title" className="font-display text-sm font-semibold text-ink">
          Import from Obsidian
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">Vaults from Obsidian's vault list.</p>
      </header>

      <div className="max-h-[22rem] overflow-y-auto px-2 py-2">
        {list.length === 0 ? (
          <Empty title="No vaults in Obsidian's list" />
        ) : (
          <ul className="space-y-px">
            {list.map((entry) => {
              const added = registered.has(entry.path);
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
                        <span className="text-xs font-semibold text-ink">{vaultName(entry.path)}</span>
                        <span className="font-mono text-[10px] text-ink-faint">{entry.id}</span>
                        {entry.open && <Chip>open</Chip>}
                        {added && <Chip tone="signal">added</Chip>}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-ink-dim" title={entry.path}>
                        {entry.path}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2.5">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="solid" disabled={picks.length === 0} onClick={runImport}>
          Import
        </Button>
      </footer>
    </Modal>
  );
}
