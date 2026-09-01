import { useEffect, useState } from "react";
import type { MergeBackStatus } from "@omp-ui/core/types";
import type { DeleteConfirmation } from "../store";
import { findRecord, runningSessionTitleOnCheckout, useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";
import { shortBase } from "../lib/format";
import { useT } from "../lib/i18n";
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
  const t = useT();
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
  const n = confirmation.cascade.length;
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
      ? t("dialog.delete.busy")
      : mergeStatus === null
        ? undefined
        : mergeStatus.destination === null
          ? t("dialog.delete.baseGone")
          : !mergeStatus.destinationCheckedOut
            ? t("dialog.delete.checkoutFirst", { destination: mergeStatus.destination })
            : mergeStatus.mergeInProgress
              ? t("dialog.delete.mergeInProgress")
              : mergeStatus.alreadyMerged
                ? t("dialog.delete.alreadyMerged", { destination: mergeStatus.destination })
                : !mergeStatus.branchExists
                  ? t("dialog.delete.branchGone")
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
        setMergeError(mergeTitle ?? t("dialog.delete.mergeNoLonger"));
        return;
      }
      setMerging(true);
      setMergeError(null);
      try {
        const result = await mergeWorktreeBranch(projectCwd, branch, mergeStatus.destination);
        if (result.kind === "conflicts") {
          setMergeError(
            t("dialog.delete.mergeConflicts", { n: result.files.length, cwd: projectCwd }),
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
      kicker={t("dialog.delete.kicker")}
      title={t("dialog.delete.title", { title: confirmation.title })}
      tone="rose"
      onClose={cancelDeleteSession}
      width="w-[28rem]"
      actions={
        <>
          <Button variant="ghost" onClick={cancelDeleteSession}>
            {t("common.dialog.cancel")}
          </Button>
          <Button
            variant="solid"
            tone="rose"
            disabled={merging || (mergeFirst && !mergeEnabled)}
            title={mergeFirst && !mergeEnabled ? mergeTitle : undefined}
            onClick={() => void handleConfirm()}
          >
            {merging
              ? t("dialog.delete.merging")
              : mergeFirst
                ? t("dialog.delete.mergeAndDelete")
                : n > 0
                  ? t("dialog.delete.deleteMany", { n: n + 1 })
                  : t("dialog.delete.deleteSession")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-dim">
          {confirmation.running && t("dialog.delete.running")}
          {confirmation.hasFiles && t("dialog.delete.erased")}
          {confirmation.worktreeBranch &&
            (mergeFirst && mergeEnabled
              ? t("dialog.delete.worktreeDeleted", { branch: confirmation.worktreeBranch })
              : mergeStatus?.alreadyMerged
                ? t("dialog.delete.worktreeAlreadyMerged", { branch: confirmation.worktreeBranch, destination })
                : t("dialog.delete.worktreeSurvives", { branch: confirmation.worktreeBranch }))}
          {t("dialog.delete.cannotUndo")}
        </p>

        {n > 0 && (
          <div className="rounded-md border border-line bg-raised px-3 py-2.5">
            <p className="text-xs font-medium text-ink">
              {t("dialog.delete.alsoDeletes", { n, s: n === 1 ? "" : "s" })}
            </p>
            <ul className="mt-1.5 list-none space-y-0.5 text-xs text-ink-mid">
              {confirmation.cascade.slice(0, 4).map((d) => (
                <li key={d.tabId} className="truncate">
                  {d.title}
                  {d.running ? t("dialog.delete.runningSuffix") : ""}
                </li>
              ))}
              {n > 4 && (
                <li>{t("dialog.delete.more", { n: n - 4 })}</li>
              )}
            </ul>
            <p className="mt-1.5 text-xs text-ink-mid">
              {t("dialog.delete.cascadeErased")}
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
            {t("dialog.delete.mergeRow", { branch, destination })}
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
          {t("dialog.delete.dontShowAgain")}
        </label>
      </div>
    </ConfirmDialog>
  );
}
