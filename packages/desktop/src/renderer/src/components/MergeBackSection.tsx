import type { ReactNode } from "react";
import { shortBase } from "../lib/format";
import { Button, ConfirmDialog } from "./ui";
import type { MergeBackController } from "./useMergeBack";

const commits = (count: number): string => `${count} commit${count === 1 ? "" : "s"}`;

type Variant = "branch" | "worktree";

const classes = {
  branch: {
    row: "rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-ink-mid hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim",
    copper: "px-1.5 py-1 text-[10px] leading-snug text-copper",
    quiet: "px-1.5 py-1 text-[10px] leading-snug text-ink-faint",
    actions: "flex gap-1.5 px-1.5 pb-0.5",
    conflicts:
      "max-h-24 overflow-y-auto px-1.5 pb-1 font-mono text-[10px] leading-relaxed text-ink-mid",
    busy: "px-1.5 py-1 text-[11px] leading-snug text-copper",
  },
  worktree: {
    row: "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none",
    copper: "px-2.5 pb-1.5 text-[10px] leading-relaxed text-copper",
    quiet: "px-2.5 pb-1.5 text-[10px] leading-relaxed text-ink-faint",
    actions: "flex gap-1.5 px-2.5 pb-1.5",
    conflicts:
      "max-h-24 overflow-y-auto px-2.5 pb-1 font-mono text-[10px] leading-relaxed text-ink-mid",
    busy: "px-2.5 py-1 text-[11px] leading-snug text-copper",
  },
} satisfies Record<Variant, Record<string, string>>;

/**
 * Shared merge-back presentation. The ordered body renderers mirror git's
 * mutually exclusive states; both decision dialogs live here with the body
 * so neither chip owns merge-specific presentation or confirmation state.
 */
export function MergeBackSection({
  controller,
  variant,
}: {
  controller: MergeBackController;
  variant: Variant;
}) {
  const { target, status, phase, confirm, busyTitle, sharers } = controller;
  if (target === null) return null;

  const style = classes[variant];
  const row = (children: ReactNode, disabled = false, onClick?: () => void): ReactNode => (
    <button type="button" role="menuitem" className={style.row} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
  const copper = (children: ReactNode): ReactNode => <p className={style.copper}>{children}</p>;
  const quiet = (children: ReactNode): ReactNode => <p className={style.quiet}>{children}</p>;
  const actions = (children: ReactNode): ReactNode => <div className={style.actions}>{children}</div>;

  const renderBody = (): ReactNode => {
    if (status === null) {
      return row(
        phase.s === "merging" ? "merging…" : `merge into ${shortBase(target.base)}`,
        true,
      );
    }
    if (phase.s === "merging" || phase.s === "returning") {
      return row(phase.s === "returning" ? "returning…" : "merging…", true);
    }
    if (status.mergeInProgress) {
      return (
        <>
          {copper(
            <>a merge is already in progress in the project — finish it there: git merge --continue or git merge --abort</>,
          )}
          {actions(
            <Button size="xs" variant="ghost" onClick={controller.openConsole}>
              open console
            </Button>,
          )}
        </>
      );
    }
    if (phase.s === "conflict") {
      return (
        <>
          {copper(<>merge stopped — {phase.files.length} file(s) conflict</>)}
          <div className={style.conflicts}>
            {phase.files.map((file) => (
              <span key={file} className="block truncate" title={file}>
                {file}
              </span>
            ))}
          </div>
          {quiet(
            <>resolve in {target.projectCwd}, then git merge --continue — or git merge --abort</>,
          )}
          {actions(
            <Button size="xs" variant="ghost" onClick={controller.openConsole}>
              open console
            </Button>,
          )}
        </>
      );
    }
    if (!status.branchExists) {
      return copper(<>branch {target.branch} no longer exists — nothing to merge</>);
    }
    if (status.destination === null) {
      const short = shortBase(target.base);
      const text =
        status.reason === "base-gone"
          ? `base ${short} no longer resolves — merge manually`
          : status.reason === "no-branch-match"
            ? `no local branch matches base ${short} — merge manually`
            : "the project is not a readable git repo — merge manually";
      return copper(text);
    }
    if (!status.destinationCheckedOut) {
      return copper(<>check out {status.destination} in the project to merge back</>);
    }
    if (status.alreadyMerged) {
      return row(`return to ${status.destination}`, false, controller.requestReturn);
    }
    if (confirm === "merge" && busyTitle !== null) {
      return (
        <>
          <div className={style.busy}>
            session “{busyTitle}” is mid-turn in the project — merging moves {status.destination} under it. The merge also returns this session to {status.destination}: the checkout and branch are removed, the session is kept.
          </div>
          {actions(
            <>
              <Button size="xs" tone="copper" onClick={() => void controller.runMerge()}>
                merge & return anyway
              </Button>
              <Button size="xs" variant="ghost" onClick={controller.cancelConfirm}>
                cancel
              </Button>
            </>,
          )}
        </>
      );
    }
    return (
      <>
        {row(
          <>
            merge into {status.destination}
            {status.ahead > 0 && (
              <span className="text-ink-faint"> · {commits(status.ahead)}</span>
            )}
          </>,
          false,
          controller.requestMerge,
        )}
        {quiet(
          <>a successful merge returns this session to {status.destination} — the checkout and the branch are removed, the session and its transcript are kept</>,
        )}
      </>
    );
  };

  const working = phase.s === "merging" || phase.s === "returning";

  return (
    <>
      {renderBody()}
      {confirm === "merge" &&
        busyTitle === null &&
        target.worktreePath !== null &&
        status !== null &&
        status.destination !== null && (
        <ConfirmDialog
          kicker="Irreversible action"
          tone="rose"
          width="w-[28rem]"
          title={`Merge ${target.branch} into ${status.destination} and return this session to it?`}
          onClose={controller.cancelConfirm}
          actions={
            <>
              <Button variant="ghost" onClick={controller.cancelConfirm}>
                cancel
              </Button>
              <Button
                variant="solid"
                tone="rose"
                disabled={working}
                onClick={() => void controller.runMerge()}
              >
                {phase.s === "merging"
                  ? "merging…"
                  : phase.s === "returning"
                    ? "returning…"
                    : "merge & return"}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p>
              Writes a merge commit in the project checkout recording the {status.ahead} committed change(s) on {target.branch} — their subjects and any issues they close. Uncommitted changes in the worktree are not included.
            </p>
            <p>
              This session then returns to {status.destination} in {target.projectCwd}: its agent restarts there with its transcript intact. The checkout {target.worktreePath} is removed — uncommitted changes there are lost — and the branch {target.branch} is deleted.
            </p>
            {sharers > 0 && (
              <p>
                {sharers} other session(s) still run in this checkout, so it and the branch are kept until they leave.
              </p>
            )}
            <p>
              A conflicted merge stops both the merge and the return: the project checkout is left with files to resolve, and this session stays on {target.branch}.
            </p>
          </div>
        </ConfirmDialog>
      )}
      {confirm === "return" &&
        target.worktreePath !== null &&
        status !== null &&
        status.destination !== null && (
        <ConfirmDialog
          kicker="Irreversible action"
          tone="rose"
          width="w-[28rem]"
          title={`Return this session to ${status.destination}?`}
          onClose={controller.cancelConfirm}
          actions={
            <>
              <Button variant="ghost" onClick={controller.cancelConfirm}>
                cancel
              </Button>
              <Button
                variant="solid"
                tone="rose"
                disabled={phase.s === "returning"}
                onClick={() => void controller.runReturn()}
              >
                {phase.s === "returning" ? "returning…" : `return to ${status.destination}`}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p>The branch {target.branch} is already in {status.destination}.</p>
            <p>
              This session returns to {status.destination} in {target.projectCwd}: its agent restarts there with its transcript intact. The checkout {target.worktreePath} is removed — uncommitted changes there are lost — and the branch {target.branch} is deleted.
            </p>
            {sharers > 0 && (
              <p>
                {sharers} other session(s) still run in this checkout, so it and the branch are kept until they leave.
              </p>
            )}
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
