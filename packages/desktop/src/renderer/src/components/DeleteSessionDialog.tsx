import { useState } from "react";
import type { DeleteConfirmation } from "../store";
import { useStore } from "../store";
import { Button, Modal } from "./ui";

export function DeleteSessionDialog({
  confirmation,
}: {
  confirmation: DeleteConfirmation;
}) {
  const [skipFuture, setSkipFuture] = useState(false);
  const confirmDeleteSession = useStore((s) => s.confirmDeleteSession);
  const cancelDeleteSession = useStore((s) => s.cancelDeleteSession);

  return (
    <Modal onClose={cancelDeleteSession} width="w-[28rem]" mobile="dialog">
      <section role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title">
        <header className="border-b border-line px-4 py-3.5">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-rose">
            Irreversible action
          </p>
          <h2 id="delete-session-title" className="font-display text-base font-semibold text-ink">
            Delete “{confirmation.title}”?
          </h2>
        </header>

        <div className="space-y-4 px-4 py-4">
          <p className="text-sm leading-relaxed text-ink-dim">
            {confirmation.running && "Its running agent will be stopped. "}
            {confirmation.hasFiles && "Its transcript and artifacts will be erased. "}
            This cannot be undone.
          </p>

          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink">
            <input
              type="checkbox"
              checked={skipFuture}
              onChange={(event) => setSkipFuture(event.target.checked)}
              className="size-3.5 accent-current"
            />
            Do not show this warning again
          </label>
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={cancelDeleteSession}>
            Cancel
          </Button>
          <Button variant="solid" tone="rose" onClick={() => void confirmDeleteSession(skipFuture)}>
            Delete session
          </Button>
        </footer>
      </section>
    </Modal>
  );
}
