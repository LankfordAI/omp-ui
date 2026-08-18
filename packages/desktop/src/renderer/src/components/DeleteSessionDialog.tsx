import { useState } from "react";
import type { DeleteConfirmation } from "../store";
import { useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";

export function DeleteSessionDialog({
  confirmation,
}: {
  confirmation: DeleteConfirmation;
}) {
  const [skipFuture, setSkipFuture] = useState(false);
  const confirmDeleteSession = useStore((s) => s.confirmDeleteSession);
  const cancelDeleteSession = useStore((s) => s.cancelDeleteSession);

  return (
    <ConfirmDialog
      kicker="Irreversible action"
      title={`Delete “${confirmation.title}”?`}
      tone="rose"
      onClose={cancelDeleteSession}
      width="w-[28rem]"
      actions={
        <>
          <Button variant="ghost" onClick={cancelDeleteSession}>
            Cancel
          </Button>
          <Button variant="solid" tone="rose" onClick={() => void confirmDeleteSession(skipFuture)}>
            Delete session
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-dim">
          {confirmation.running && "Its running agent will be stopped. "}
          {confirmation.hasFiles && "Its transcript and artifacts will be erased. "}
          {confirmation.worktreeBranch &&
            `Its worktree checkout will be removed — uncommitted changes there are lost. Commits survive on ${confirmation.worktreeBranch}. `}
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
    </ConfirmDialog>
  );
}
