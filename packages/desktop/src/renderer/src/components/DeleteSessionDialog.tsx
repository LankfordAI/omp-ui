import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { MergeBackStatus } from "@omp-ui/core/types";
import { displayMessage } from "../backend";
import type { BulkDeleteConfirmation, DeleteConfirmation } from "../store";
import { checkoutOccupant, findOwner, findRecord, occupantActivityPhrase, skipConfirmationCovers, useStore } from "../store";
import { projectKey } from "../lib/project-key";
import { Button, ConfirmDialog } from "./ui";
import { shortBase } from "../lib/format";
/**
 * Session delete confirmation. For worktree sessions, offers a merge-back of
 * the branch first (issue #272): the destination is the recorded base, or the
 * repo's default branch when no base was recorded, and the merge runs in the
 * project checkout or a scratch worktree (issue #385) — the delete follows
 * only when it does not stop on conflicts. The checkout's dirtiness is read
 * (issue #388) so the description names the loss only when there is one.
 * The opt-out checkbox appears only where the skip setting can suppress this
 * confirmation (issue #641): never for a worktree checkout in the closure.
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
  const resolveMergeDestination = useStore((s) => s.resolveMergeDestination);
  const readMergeBackStatus = useStore((s) => s.readMergeBackStatus);
  const mergeWorktreeBranch = useStore((s) => s.mergeWorktreeBranch);
  // The session's owning instance (issue #416): its branches and merges live there.
  const instanceId = useStore((s) => findOwner(s.state, confirmation.tabId)?.instanceId ?? null);
  const projectCwd = useStore((s) => findRecord(s.state, confirmation.tabId)?.projectCwd);
  const defaultBranch = useStore((s) =>
    projectCwd === undefined
      ? null
      : (s.branches[projectKey(instanceId, projectCwd)]?.defaultBranch ?? null),
  );

  const branch = confirmation.worktreeBranch;
  const base = confirmation.worktreeBase;
  const worktreePath = confirmation.worktreePath;
  const n = confirmation.cascade.length;
  const offerOptOut = skipConfirmationCovers(confirmation);
  // Another live session occupying the project checkout: merging moves the
  // destination branch out from under it. The deleted session's own tab is excluded.
  const occupant = useStore(
    useShallow((s) => checkoutOccupant(s, projectCwd, confirmation.tabId, instanceId)),
  );
  const busyTitle = occupant?.title ?? null;

  useEffect(() => {
    if (branch === null || projectCwd === undefined) return;
    let cancelled = false;
    // The recorded base first; a null base falls back to the listing's
    // default branch (this dialog does not refresh branches — absent means
    // no merge row, matching the pre-field records' old silence).
    void (async () => {
      const destination =
        base !== null
          ? ((await resolveMergeDestination(projectCwd, base, instanceId).catch(() => null))?.destination ??
            // Unresolvable base: still read it by name so the row explains
            // itself via destinationExists false ("the base no longer resolves").
            base)
          : defaultBranch;
      if (destination === null || destination === undefined) return;
      if (cancelled) return;
      try {
        const status = await readMergeBackStatus(
          projectCwd,
          branch,
          destination,
          worktreePath,
          instanceId,
        );
        if (!cancelled) setMergeStatus(status);
      } catch {
        // Unreadable status: treat as un-mergeable. No error shown — delete
        // stays the point of this dialog.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branch, base, worktreePath, projectCwd, instanceId, defaultBranch, resolveMergeDestination, readMergeBackStatus]);

  const mergeRow = branch !== null && projectCwd !== undefined;
  const destination =
    mergeStatus?.destination ?? (base !== null ? shortBase(base) : (defaultBranch ?? ""));
  const onProjectCheckout = mergeStatus?.destinationCheckout === "project";
  // Uncommitted project-checkout edits to files the merge would overwrite:
  // git refuses over them, so the merge row says why instead of clicking
  // into the refusal (issue #1050).
  const destinationDirty = (mergeStatus?.destinationDirtyFiles?.length ?? 0) > 0;
  const mergeEnabled =
    mergeStatus !== null &&
    mergeStatus.destinationExists &&
    mergeStatus.branchExists &&
    mergeStatus.destinationCheckout !== "other" &&
    !(onProjectCheckout && (mergeStatus.mergeInProgress || busyTitle !== null || destinationDirty)) &&
    !mergeStatus.alreadyMerged;
  const mergeTitle =
    mergeStatus === null
      ? undefined
      : mergeStatus.destinationCheckout === "other"
        ? `${mergeStatus.destination} is checked out in another worktree`
        : onProjectCheckout && occupant !== null
          ? `session “${occupant.title}” ${occupantActivityPhrase(occupant.reason)}`
          : mergeStatus === null
            ? undefined
            : !mergeStatus.destinationExists
              ? "the recorded base no longer resolves"
              : onProjectCheckout && mergeStatus.mergeInProgress
                ? "a merge is already in progress in the project"
                : destinationDirty
                  ? "the project checkout has uncommitted changes to files this merge would overwrite — commit or stash them first"
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
      if (!mergeEnabled || branch === null || projectCwd === undefined || mergeStatus === null) {
        setMergeError(mergeTitle ?? "the merge is no longer possible — uncheck it to delete plainly");
        return;
      }
      setMerging(true);
      setMergeError(null);
      try {
        const result = await mergeWorktreeBranch(projectCwd, branch, mergeStatus.destination, instanceId);
        if (result.kind === "conflicts") {
          setMergeError(
            result.conflictsLeftIn === "project"
              ? `the merge stopped on ${result.files.length} file(s) — resolve them in ${projectCwd}, then delete without merging`
              : `the merge would conflict on ${result.files.length} file(s) and was not applied — delete without merging, or finish the worktree from its tab`,
          );
        } else {
          // ff / merged / already-merged: the branch is safely in, proceed.
          void confirmDeleteSession(skipFuture);
        }
      } catch (err) {
        // The IPC wrapper must never reach the row (#16, #674, #1050).
        setMergeError(displayMessage(err));
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
            {merging
              ? "merging…"
              : mergeFirst
                ? "merge & delete"
                : n > 0
                  ? `Delete ${n + 1} sessions`
                  : "Delete session"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-dim">
          {confirmation.running && "Its running agent will be stopped. "}
          {confirmation.hasFiles && "Its transcript and artifacts will be erased. "}
          {confirmation.worktreeBranch &&
            (mergeFirst && mergeEnabled
              ? `Its worktree checkout will be removed and the branch ${confirmation.worktreeBranch} deleted. `
              : mergeStatus?.alreadyMerged
                ? `Its worktree checkout will be removed. The branch ${confirmation.worktreeBranch} (already in ${destination}) is deleted. `
                : `Its worktree checkout will be removed. Commits survive on ${confirmation.worktreeBranch}. `)}
          {mergeStatus?.worktreeDirty === true && "Uncommitted changes in its checkout are lost. "}
          This cannot be undone.
        </p>

        {n > 0 && (
          <div className="rounded-md border border-line bg-raised px-3 py-2.5">
            <p className="text-xs font-medium text-ink">
              {`Also deletes ${n} plan implementation descendant${n === 1 ? "" : "s"}`}
            </p>
            <ul className="mt-1.5 list-none space-y-0.5 text-xs text-ink-mid">
              {confirmation.cascade.slice(0, 4).map((d) => (
                <li key={d.tabId} className="truncate">
                  {d.title}
                  {d.running ? " · running" : ""}
                  {d.worktree ? " · worktree" : ""}
                </li>
              ))}
              {n > 4 && (
                <li>{`+${n - 4} more`}</li>
              )}
            </ul>
            <p className="mt-1.5 text-xs text-ink-mid">
              Their transcripts and artifacts are erased too, and any running agent among them is stopped.
            </p>
          </div>
        )}

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
            {`merge ${branch} into ${destination} first`}
          </label>
        )}

        {mergeError !== null && (
          <p className="text-xs leading-relaxed text-rose">{mergeError}</p>
        )}

        {offerOptOut && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink">
            <input
              type="checkbox"
              checked={skipFuture}
              onChange={(event) => setSkipFuture(event.target.checked)}
              className="size-3.5 accent-current"
            />
            Do not show this warning again
          </label>
        )}
      </div>
    </ConfirmDialog>
  );
}

/**
 * The bulk Delete confirmation (issue #988): the selection bar's Delete…
 * names the count and lists the rows it erases, with the same "running",
 * "worktree", and cascade facts the single dialog states. No merge-back row:
 * a merge is a per-session choice, so a worktree row is deleted with its
 * commits surviving on the branch. The opt-out shows only where it would
 * cover every row (issue #641).
 */
export function BulkDeleteSessionsDialog({ confirmation }: { confirmation: BulkDeleteConfirmation }) {
  const [skipFuture, setSkipFuture] = useState(false);
  const confirmDeleteSessions = useStore((s) => s.confirmDeleteSessions);
  const cancelDeleteSessions = useStore((s) => s.cancelDeleteSessions);
  const { rows } = confirmation;
  const descendants = rows.reduce((n, row) => n + row.cascade.length, 0);
  const anyRunning = rows.some((row) => row.running || row.cascade.some((d) => d.running));
  const anyWorktree = rows.some((row) => row.worktreePath !== null || row.cascade.some((d) => d.worktree));
  const offerOptOut = rows.every((row) => skipConfirmationCovers(row));
  const shown = rows.slice(0, 6);

  return (
    <ConfirmDialog
      kicker="Irreversible action"
      title={`Delete ${rows.length} sessions?`}
      tone="rose"
      onClose={cancelDeleteSessions}
      width="w-[28rem]"
      actions={
        <>
          <Button variant="ghost" onClick={cancelDeleteSessions}>
            Cancel
          </Button>
          <Button variant="solid" tone="rose" onClick={() => void confirmDeleteSessions(skipFuture)}>
            {`Delete ${rows.length + descendants} sessions`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="list-none space-y-0.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid">
          {shown.map((row) => (
            <li key={row.tabId} className="truncate">
              {row.title}
              {row.running ? " · running" : ""}
              {row.worktreeBranch !== null ? " · worktree" : ""}
            </li>
          ))}
          {rows.length > shown.length && <li>{`+${rows.length - shown.length} more`}</li>}
        </ul>
        <p className="text-sm leading-relaxed text-ink-dim">
          {anyRunning && "Their running agents will be stopped. "}
          {"Their transcripts and artifacts will be erased. "}
          {anyWorktree && "Their worktree checkouts will be removed, uncommitted changes included. "}
          {descendants > 0 && `Also deletes ${descendants} plan implementation descendant${descendants === 1 ? "" : "s"}`}
          {descendants > 0 && ". "}
          This cannot be undone.
        </p>
        {offerOptOut && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink">
            <input
              type="checkbox"
              checked={skipFuture}
              onChange={(event) => setSkipFuture(event.target.checked)}
              className="size-3.5 accent-current"
            />
            Do not show this warning again
          </label>
        )}
      </div>
    </ConfirmDialog>
  );
}
