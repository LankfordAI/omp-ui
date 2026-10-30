import { useCallback } from "react";
import { useStore } from "../store";
import { formatHotkey } from "../lib/hotkeys";
import { useSettleUndoHotkey } from "../lib/use-settle-undo-hotkey";
import { useT } from "../lib/i18n";
import { Button, UpdateCard } from "./ui";

/** How long the Undo toast stays; Mod+Z keeps working after it closes. */
export const SETTLE_TOAST_MS = 8000;

/**
 * The transient toast a Settle leaves (issue #980): names what settled and
 * offers Undo. Same corner stack as the update cards (App.tsx positions it).
 * Closing it never forfeits the undo — `Mod+Z` still reaches the entry.
 */
export function SettleToast() {
  const t = useT();
  useSettleUndoHotkey();
  const entry = useStore((s) =>
    s.settleToastId === null ? undefined : s.settleUndo.find((e) => e.id === s.settleToastId),
  );
  const undoSettle = useStore((s) => s.undoSettle);
  const dismiss = useStore((s) => s.dismissSettleToast);
  // Stable identity: UpdateCard's timer restarts whenever onDismiss changes.
  const onDismiss = useCallback(() => dismiss(), [dismiss]);
  if (entry === undefined) return null;
  const n = entry.sessions.length;
  return (
    // key: a newer settle restarts the auto-dismiss window.
    <UpdateCard key={entry.id} dismissLabel={t("update.card.dismiss")} onDismiss={onDismiss} autoDismissMs={SETTLE_TOAST_MS}>
      <div role="status" className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">
          {n === 1 ? t("settle.toast.one", { title: entry.sessions[0]!.title }) : t("settle.toast.many", { n })}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Button variant="outline" size="xs" onClick={() => void undoSettle()}>
            {t("settle.toast.undo")}
          </Button>
          <span className="font-mono text-[10px] text-ink-faint">{formatHotkey("mod+z")}</span>
        </div>
      </div>
    </UpdateCard>
  );
}
