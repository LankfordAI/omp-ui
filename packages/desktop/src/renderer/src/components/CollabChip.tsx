import { useStore } from "../store";
import { Button } from "./ui";
import { useT } from "../lib/i18n";

/**
 * The terminal tab's live-share chip (issue #686): shows while this tab
 * hosts a Collab room (or a guest is waiting on the host's TUI), and opens
 * the Share-live dialog. Off-state tabs render nothing — the palette action
 * is the entry point; a permanent chip would just tax the terminal header.
 */
export function CollabChip({ tabId }: { tabId: string }) {
  const t = useT();
  const open = useStore((s) => s.openShareLive);
  const view = useStore((s) => s.collab[tabId]);
  if (view?.kind !== "sharing") return null;
  const { state } = view;
  return (
    <Button
      variant="outline"
      tone={state.inputRequired ? "copper" : "signal"}
      className="bg-surface/90 backdrop-glass"
      title={
        state.inputRequired
          ? t("collab.chip.inputRequired")
          : state.status === "full"
            ? t("collab.chip.sharingFull")
            : t("collab.chip.sharingView")
      }
      onClick={() => open(tabId)}
    >
      <span
        aria-hidden
        className={
          "size-1.5 rounded-full " +
          (state.inputRequired ? "bg-copper" : state.relayConnected ? "bg-signal" : "bg-rose")
        }
      />
      {t("collab.chip.live")}
      {state.participants > 0 && (
        <span className="font-mono tabular-nums">{state.participants}</span>
      )}
    </Button>
  );
}
