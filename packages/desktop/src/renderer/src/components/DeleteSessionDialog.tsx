import { useEffect, useState } from "react";
import type { MergeBackStatus } from "@omp-ui/core/types";
import type { DeleteConfirmation } from "../store";
import { findRecord, runningSessionTitleOnCheckout, useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";
import { shortBase } from "./WorktreeChip";
/**
 * Session delete confirmation. For worktree sessions, offers a merge-back of the
 * branch first (issue #272): the merge into the recorded base runs in the
 * project checkout, and the delete follows only when it does not stop on conflicts.
 */
export function DeleteSessionDialog({
  confirmation,
}: {
  confirmation: DeleteConfirmation;
}) {
  const [skipFuture, setSkipFuture] = useState(false);
  const [mergeFirst, setMergeFirst] = useState(false);
  const [mergeStatus, setMergeStatus] = useState<MergeBackStatus | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const confirmDeleteSession = useStore((s) => s.confirmDeleteSession);
  const cancelDeleteSession = useStore((s) => s.cancelDeleteSession);
  const readMergeBackStatus = useStore((s) => s.readMergeBackStatus);
  const mergeWorktreeBranch = useStore((s) => s.mergeWorktreeBranch);

  const branch = confirmation.worktreeBranch;
  const base = confirmation.worktreeBase;
  const projectCwd = useStore(
    (s) => findRecord(s.state, confirmation.tabId)?.projectCwd,
  );
  // A session mid-turn in the project checkout: merging moves the destination
  // branch out from under it. The deleted session's own tab is excluded.
  const busyTitle = useStore((s) =>
    runningSessionTitleOnCheckout(s, projectCwd, confirmation.tabId),
  );

  useEffect(() => {
    if (branch === null || base === null || projectCwd === undefined) return;
    let cancelled = false;
    readMergeBackStatus(projectCwd, branch, base)
      .then((status) => {
        if (!cancelled) setMergeStatus(status);
      })
      .catch(() => {
        // Unreadable status: treat as un-mergeable. No error shown — delete
        // stays the point of this dialog.
      });
    return () => {
      cancelled = true;
    };
  }, [branch, base, projectCwd, readMergeBackStatus]);

  const mergeRow = branch !== null && base !== null && projectCwd !== undefined;
  const destination = mergeStatus?.destination ?? (base !== null ? shortBase(base) : "");
  const mergeEnabled =
    mergeStatus !== null &&
    mergeStatus.destination !== null &&
    mergeStatus.destinationCheckedOut &&
    mergeStatus.branchExists &&
    !mergeStatus.mergeInProgress &&
    !mergeStatus.alreadyMerged &&
    busyTitle === null;
  const mergeTitle =
    busyTitle !== null
      ? "a session is mid-turn in the project"
      : mergeStatus === null
        ? undefined
        : mergeStatus.destination === null
          ? "the recorded base no longer resolves"
          : !mergeStatus.destinationCheckedOut
            ? `check out ${mergeStatus.destination} in the project first`
            : mergeStatus.mergeInProgress
              ? "a merge is already in progress in the project"
              : mergeStatus.alreadyMerged
                ? `already in ${mergeStatus.destination}`
                : !mergeStatus.branchExists
                  ? "the worktree branch no longer exists — nothing to merge"
                  : undefined;

  const handleConfirm = async (): Promise<void> => {
    if (mergeFirst) {
      // The checkbox can only be ticked while mergeable, but the status can
      // change while the dialog is open — never delete without the merge
      // the user asked for.
      if (
        !mergeEnabled ||
        branch === null ||
        projectCwd === undefined ||
        mergeStatus?.destination === null
      ) {
        setMergeError(mergeTitle ?? "the merge is no longer possible — uncheck it to delete plainly");
        return;
      }
      setMerging(true);
      setMergeError(null);
      try {
        const result = await mergeWorktreeBranch(projectCwd, branch, mergeStatus.destination);
        if (result.kind === "conflicts") {
          setMergeError(
            `the merge stopped on ${result.files.length} file(s) — resolve them in ${projectCwd}, then delete without merging`,
          );
        } else {
          // ff / merged / already-merged: the branch is safely in, proceed.
          void confirmDeleteSession(skipFuture);
        }
      } catch (err) {
        setMergeError(err instanceof Error ? err.message : String(err));
      } finally {
        setMerging(false);
      }
      return;
    }
    void confirmDeleteSession(skipFuture);
  };

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
          <Button
            variant="solid"
            tone="rose"
            disabled={merging || (mergeFirst && !mergeEnabled)}
            title={mergeFirst && !mergeEnabled ? mergeTitle : undefined}
            onClick={() => void handleConfirm()}
          >
            {merging ? "merging…" : mergeFirst ? "merge & delete" : "Delete session"}
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

        {mergeRow && (
          <label
            className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink"
            title={mergeTitle}
          >
            <input
              type="checkbox"
              checked={mergeFirst}
              disabled={!mergeEnabled || merging}
              onChange={(event) => setMergeFirst(event.target.checked)}
              className="size-3.5 accent-current"
            />
            merge {branch} into {destination} first
          </label>
        )}

        {mergeError !== null && (
          <p className="text-xs leading-relaxed text-rose">{mergeError}</p>
        )}

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
