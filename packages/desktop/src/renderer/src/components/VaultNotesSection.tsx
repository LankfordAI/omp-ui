import { useMemo } from "react";
import { useT } from "../lib/i18n";
import type { RenderItem } from "../lib/transcript";
import { touchedVaultNotes } from "../lib/vault-notes";
import { useStore } from "../store";
import { OpenInObsidianButton } from "./OpenInObsidianButton";
import { Section } from "./RailSection";
import { Chip } from "./ui";
import { NoteGlyph, VaultActionChip } from "./VaultToolCard";

const NO_ITEMS: RenderItem[] = [];

/**
 * "Vault notes" (issue #767): the notes this session's transcript touched,
 * derived from its vault write cards (#759), so a joined app or browser client
 * lists what the cards show. Subagent buffers are not read.
 */
export function VaultNotesSection({ tabId, onJump }: { tabId: string; onJump?: () => void }) {
  const t = useT();
  const items = useStore((s) => s.rpc[tabId]?.items ?? NO_ITEMS);
  const multiVault = useStore((s) => (s.state?.vaultRegistry.vaults.length ?? 0) > 1);
  const notes = useMemo(() => touchedVaultNotes(items), [items]);
  return (
    <Section title={t("rail.vault.title")} action={notes.length > 0 ? <Chip mono>{notes.length}</Chip> : undefined}>
      {notes.length === 0 ? (
        <p className="text-[11px] text-ink-faint">{t("rail.vault.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {notes.map((note) => (
            <li key={`${note.vaultName}\u0000${note.path}`} className="flex min-w-0 items-center gap-1.5">
              <NoteGlyph className="text-ink-dim" />
              <button
                type="button"
                title={note.path}
                className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:underline hover:decoration-dotted hover:underline-offset-2"
                onClick={() => {
                  onJump?.();
                  // Centres the row the way the find bar does; a no-op when the transcript is not mounted.
                  document
                    .querySelector(`[data-tab-id="${CSS.escape(tabId)}"] [data-item-id="${CSS.escape(note.itemId)}"]`)
                    ?.scrollIntoView({ block: "center" });
                }}
              >
                {note.title}
              </button>
              <VaultActionChip action={note.action} />
              {multiVault && (
                <Chip mono truncate title={note.vaultName} className="max-w-24">
                  {note.vaultName}
                </Chip>
              )}
              <OpenInObsidianButton vaultName={note.vaultName} file={note.path} tabId={tabId} iconOnly />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
