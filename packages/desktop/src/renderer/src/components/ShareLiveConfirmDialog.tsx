import { useId } from "react";
import { useStore } from "../store";
import { Button, Modal } from "./ui";

/**
 * The first live-share privacy dialog (issue #686): what omp's /collab
 * guarantees while a room is open. One confirm per install, sharing the
 * flag with the snapshot /share dialog (#679) — the facts differ, the
 * contract (omp publishes, a link is secret material) does not.
 */
export function ShareLiveConfirmDialog() {
  const titleId = useId();
  const confirm = useStore((s) => s.confirmShareLivePrivacy);
  const cancel = useStore((s) => s.cancelShareLivePrivacy);

  return (
    <Modal onClose={cancel} labelledBy={titleId} width="w-[32rem]" role="alertdialog">
      <div className="border-b border-line px-5 pb-4 pt-5">
        <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight text-ink">
          Share this session live?
        </h2>
        <p className="mt-0.5 text-xs text-ink-dim">omp opens a live Collab room. Before the first share:</p>
      </div>
      <ul className="space-y-2.5 px-5 py-4 text-xs leading-relaxed text-ink-mid">
        <li className="flex gap-2">
          <span aria-hidden className="text-ink-faint">
            •
          </span>
          <span>guests see the session as it runs — a live room, not a snapshot; anything said while they watch is visible to them</span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-ink-faint">
            •
          </span>
          <span>the key lives only in the link’s fragment — the relay never sees plaintext</span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-ink-faint">
            •
          </span>
          <span>stop sharing in this dialog, or close the session; the next room rotates the key</span>
        </li>
      </ul>
      <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button size="sm" variant="ghost" onClick={cancel}>
          cancel
        </Button>
        <Button size="sm" variant="solid" onClick={confirm}>
          share
        </Button>
      </footer>
    </Modal>
  );
}
