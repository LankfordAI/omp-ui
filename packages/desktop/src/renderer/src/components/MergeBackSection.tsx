import type { ReactNode } from "react";
import { shortBase } from "../lib/format";
import { useT } from "../lib/i18n";
import { Button, ConfirmDialog } from "./ui";
import type { MergeBackController } from "./useMergeBack";


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
  const t = useT();
  const commits = (count: number): string =>
    t(count === 1 ? "branch.merge.oneCommit" : "branch.merge.manyCommits", { count });
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
        phase.s === "merging" ? t("branch.merge.merging") : t("branch.merge.mergeInto", { destination: shortBase(target.base) }),
        true,
      );
    }
    if (phase.s === "merging" || phase.s === "returning") {
      return row(phase.s === "returning" ? t("branch.merge.returning") : t("branch.merge.merging"), true);
    }
    if (status.mergeInProgress) {
      return (
        <>
          {copper(
            <>{t("branch.merge.inProgress")}</>,
          )}
          {actions(
            <Button size="xs" variant="ghost" onClick={controller.openConsole}>
              {t("branch.merge.openConsole")}
            </Button>,
          )}
        </>
      );
    }
    if (phase.s === "conflict") {
      return (
        <>
          {copper(<>{t("branch.merge.conflictCount", { count: phase.files.length })}</>)}
          <div className={style.conflicts}>
            {phase.files.map((file) => (
              <span key={file} className="block truncate" title={file}>
                {file}
              </span>
            ))}
          </div>
          {quiet(
            <>{t("branch.merge.resolveHint", { cwd: target.projectCwd })}</>,
          )}
          {actions(
            <Button size="xs" variant="ghost" onClick={controller.openConsole}>
              {t("branch.merge.openConsole")}
            </Button>,
          )}
        </>
      );
    }
    if (!status.branchExists) {
      return copper(<>{t("branch.merge.branchGone", { branch: target.branch })}</>);
    }
    if (status.destination === null) {
      const short = shortBase(target.base);
      const text =
        status.reason === "base-gone"
          ? t("branch.merge.baseGone", { base: short })
          : status.reason === "no-branch-match"
            ? t("branch.merge.noBranchMatch", { base: short })
            : t("branch.merge.notReadableRepo");
      return copper(text);
    }
    if (!status.destinationCheckedOut) {
      return copper(<>{t("branch.merge.checkoutFirst", { destination: status.destination })}</>);
    }
    if (status.alreadyMerged) {
      return row(t("branch.merge.returnTo", { destination: status.destination }), false, controller.requestReturn);
    }
    if (confirm === "merge" && busyTitle !== null) {
      return (
        <>
          <div className={style.busy}>
            {t("branch.merge.busyWarning", { title: busyTitle, destination: status.destination })}
          </div>
          {actions(
            <>
              <Button size="xs" tone="copper" onClick={() => void controller.runMerge()}>
                {t("branch.merge.mergeReturnAnyway")}
              </Button>
              <Button size="xs" variant="ghost" onClick={controller.cancelConfirm}>
                {t("branch.merge.cancel")}
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
            {t("branch.merge.mergeInto", { destination: status.destination })}
            {status.ahead > 0 && (
              <span className="text-ink-faint"> · {commits(status.ahead)}</span>
            )}
          </>,
          false,
          controller.requestMerge,
        )}
        {quiet(
          <>{t("branch.merge.successHint", { destination: status.destination })}</>,
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
          kicker={t("branch.merge.irreversible")}
          tone="rose"
          width="w-[28rem]"
          title={t("branch.merge.confirmTitle", { branch: target.branch, destination: status.destination })}
          onClose={controller.cancelConfirm}
          actions={
            <>
              <Button variant="ghost" onClick={controller.cancelConfirm}>
                {t("branch.merge.cancel")}
              </Button>
              <Button
                variant="solid"
                tone="rose"
                disabled={working}
                onClick={() => void controller.runMerge()}
              >
                {phase.s === "merging"
                  ? t("branch.merge.merging")
                  : phase.s === "returning"
                    ? t("branch.merge.returning")
                    : t("branch.merge.mergeReturn")}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p>
              {t("branch.merge.confirmCommit", { count: status.ahead, branch: target.branch })}
            </p>
            <p>
              {t("branch.merge.confirmCleanup", { destination: status.destination, cwd: target.projectCwd, path: target.worktreePath, branch: target.branch })}
            </p>
            {sharers > 0 && (
              <p>
                {t("branch.merge.sharers", { count: sharers })}
              </p>
            )}
            <p>
              {t("branch.merge.conflictedResult", { branch: target.branch })}
            </p>
          </div>
        </ConfirmDialog>
      )}
      {confirm === "return" &&
        target.worktreePath !== null &&
        status !== null &&
        status.destination !== null && (
        <ConfirmDialog
          kicker={t("branch.merge.irreversible")}
          tone="rose"
          width="w-[28rem]"
          title={t("branch.merge.returnTitle", { destination: status.destination })}
          onClose={controller.cancelConfirm}
          actions={
            <>
              <Button variant="ghost" onClick={controller.cancelConfirm}>
                {t("branch.merge.cancel")}
              </Button>
              <Button
                variant="solid"
                tone="rose"
                disabled={phase.s === "returning"}
                onClick={() => void controller.runReturn()}
              >
                {phase.s === "returning" ? t("branch.merge.returning") : t("branch.merge.returnTo", { destination: status.destination })}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p>{t("branch.merge.alreadyIn", { branch: target.branch, destination: status.destination })}</p>
            <p>
              {t("branch.merge.returnCleanup", { destination: status.destination, cwd: target.projectCwd, path: target.worktreePath, branch: target.branch })}
            </p>
            {sharers > 0 && (
              <p>
                {t("branch.merge.sharers", { count: sharers })}
              </p>
            )}
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
