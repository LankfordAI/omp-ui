import { useEffect, useId } from "react";
import { useT, type MessageKey } from "../lib/i18n";
import { useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";
import { useFinishWorktree, type FinishStep } from "./useFinishWorktree";

/**
 * The Finish worktree dialog (issues #385–#389): one surface, three
 * independent decisions — where the work goes (destination: resolved base,
 * any local branch, or a new branch cut from a chosen start point), how it
 * lands (merge commit vs keep the branch, optionally renamed), and whether
 * the session returns to the project checkout. The merge is previewed with
 * git merge-tree before anything moves; a predicted conflict offers the
 * sync path so conflicts are resolved in the worktree by the session that
 * owns the change. A dirty checkout cannot be returned — the checkbox says
 * so, and main enforces it. Supersedes the merge rows the two chips used to
 * carry inline.
 */

const stepLabel: Record<FinishStep, MessageKey> = {
  creating: "finish.step.creating",
  renaming: "finish.step.renaming",
  merging: "finish.step.merging",
  syncing: "finish.step.syncing",
  returning: "finish.step.returning",
};

const fieldClass =
  "mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong";
const labelClass = "block text-[10px] text-ink-faint";
const quietClass = "text-[10px] leading-snug text-ink-faint";
const copperClass = "text-[10px] leading-snug text-copper";
const radioRowClass =
  "flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink has-[:checked]:border-line-strong has-[:checked]:text-ink";

export function FinishWorktreeDialog({ tabId }: { tabId: string }) {
  const t = useT();
  const c = useFinishWorktree(tabId);
  const closeFinishWorktree = useStore((s) => s.closeFinishWorktree);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const consoleIsOpen = useStore((s) => s.consoleOpen[tabId] === true);
  const ids = useId();

  // The record vanished (deleted, released elsewhere) or lost its worktree:
  // the dialog has nothing left to finish.
  useEffect(() => {
    if (c.record === undefined || c.record.worktree === null) closeFinishWorktree();
  }, [c.record, closeFinishWorktree]);

  const record = c.record;
  const worktree = record?.worktree ?? null;
  if (record === undefined || worktree === null) return null;

  const branch = worktree.branch;
  const status = c.status;
  const dirty = status?.worktreeDirty === true;
  const targetName =
    c.newBranch !== null ? c.newBranch.name.trim() : (c.destination ?? "");
  // The merge radio's blockers mirror the controller's primary gate — a
  // scratch merge (new branch included) is immune to the project checkout's
  // mid-merge, and only an "other"-held destination refuses outright.
  const mergeBlocked =
    status !== null &&
    c.newBranch === null &&
    (status.destinationCheckout === "other" ||
      (status.destinationCheckout === "project" && status.mergeInProgress));

  const working = c.phase.s === "working";
  const label =
    c.phase.s === "loading"
      ? t("finish.dialog.loading")
      : c.phase.s === "working"
        ? t(stepLabel[c.phase.step])
        : (c.primaryLabel ?? t("finish.primary.nothing"));

  const mergeSublabel = (): React.ReactNode => {
    if (status === null) return null;
    if (c.newBranch === null && status.destinationCheckout === "other")
      return <p className={copperClass}>{t("finish.dialog.heldElsewhere", { destination: targetName })}</p>;
    if (c.newBranch === null && status.destinationCheckout === "project" && status.mergeInProgress)
      return <p className={copperClass}>{t("branch.merge.inProgress")}</p>;
    if (status.alreadyMerged)
      return (
        <p className={quietClass}>{t("finish.dialog.alreadyIn", { branch, destination: targetName })}</p>
      );
    const preview = status.preview;
    return (
      <>
        {preview.kind === "clean" && <p className={quietClass}>{t("finish.dialog.previewClean")}</p>}
        {preview.kind === "unknown" && <p className={quietClass}>{t("finish.dialog.previewUnknown")}</p>}
        {preview.kind === "conflicts" && (
          <>
            <p className={copperClass}>
              {t("finish.dialog.previewConflicts", { count: preview.files.length })}
            </p>
            <ul className="mt-1 space-y-0.5">
              {preview.files.slice(0, 5).map((file) => (
                <li key={file} className="truncate font-mono text-[10px] text-copper" title={file}>
                  {file}
                </li>
              ))}
              {preview.files.length > 5 && (
                <li className={quietClass}>{t("dialog.delete.more", { n: preview.files.length - 5 })}</li>
              )}
            </ul>
            <Button
              size="xs"
              variant="ghost"
              className="mt-1"
              disabled={working || c.ownRunning || dirty}
              title={
                c.ownRunning
                  ? t("finish.dialog.syncBlockedRunning")
                  : dirty
                    ? t("finish.dialog.syncBlockedDirty")
                    : undefined
              }
              onClick={() => void c.sync()}
            >
              {t("finish.dialog.syncFirst", { destination: c.newBranch === null ? targetName : c.newBranch.from })}
            </Button>
          </>
        )}
        {c.newBranch === null &&
          status.destinationCheckout === "project" &&
          c.busyTitle !== null && (
            <p className={copperClass}>
              {t("finish.dialog.busyProject", { title: c.busyTitle, destination: targetName })}
            </p>
          )}
      </>
    );
  };

  const returnHint = (): string => {
    if (c.outcome === "merge")
      return c.returnSession
        ? t("finish.hint.mergeReturn", { branch, destination: targetName })
        : t("finish.hint.mergeStay");
    return c.returnSession
      ? t("finish.hint.keepReturn", { branch })
      : t("finish.hint.keepStay");
  };

  return (
    <ConfirmDialog
      kicker={t("finish.dialog.kicker")}
      title={t("finish.dialog.title", { branch })}
      tone="neutral"
      onClose={closeFinishWorktree}
      width="w-[30rem]"
      actions={
        <>
          <Button variant="ghost" onClick={closeFinishWorktree}>
            {t("common.dialog.cancel")}
          </Button>
          <Button
            variant="solid"
            tone={c.returnSession ? "rose" : "neutral"}
            disabled={c.primaryLabel === null || working || c.phase.s === "loading"}
            onClick={() => void c.run()}
          >
            {label}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 1. What the git says, in one quiet line — plus the two states
            that change what finishing can do. */}
        <div className="space-y-1.5">
          <p className="text-xs text-ink-faint">
            {status === null
              ? "…"
              : status.alreadyMerged
                ? t("finish.dialog.alreadyIn", { branch, destination: targetName })
                : t("finish.dialog.facts", {
                    ahead: t(status.ahead === 1 ? "branch.merge.oneCommit" : "branch.merge.manyCommits", { count: status.ahead }),
                    behind: status.behind,
                    destination: targetName,
                  })}
          </p>
          {dirty && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs leading-snug text-copper">{t("finish.dialog.dirty")}</p>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  if (!consoleIsOpen) toggleConsole(tabId);
                }}
              >
                {t("finish.dialog.openConsole")}
              </Button>
            </div>
          )}
          {c.sharers > 0 && (
            <p className="text-xs leading-snug text-ink-faint">
              {t("branch.merge.sharers", { count: c.sharers })}
            </p>
          )}
        </div>

        {/* 2. Where the work goes. The worktree's own branch is not a
            destination; "new branch…" cuts one from a chosen start point. */}
        <div>
          <label htmlFor={`${ids}-dest`} className={labelClass}>
            {t("finish.dialog.destination")}
          </label>
          <select
            id={`${ids}-dest`}
            className={fieldClass}
            value={c.newBranch !== null ? "__new__" : (c.destination ?? "")}
            onChange={(event) => {
              if (event.target.value === "__new__") c.chooseNewBranch();
              else c.setDestination(event.target.value);
            }}
          >
            {c.destination === null && c.newBranch === null && (
              <option value="" disabled>
                {t("finish.dialog.loading")}
              </option>
            )}
            {c.branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value="__new__">{t("finish.dialog.newBranchOption")}</option>
          </select>
          {c.newBranch !== null && (
            <div className="mt-2 space-y-2">
              <div>
                <label htmlFor={`${ids}-nb-name`} className={labelClass}>
                  {t("finish.dialog.newBranchName")}
                </label>
                <input
                  id={`${ids}-nb-name`}
                  className={fieldClass}
                  value={c.newBranch.name}
                  placeholder="release/next"
                  spellCheck={false}
                  onChange={(event) => c.setNewBranch({ name: event.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`${ids}-nb-from`} className={labelClass}>
                  {t("finish.dialog.newBranchFrom")}
                </label>
                <select
                  id={`${ids}-nb-from`}
                  className={fieldClass}
                  value={c.newBranch.from}
                  onChange={(event) => c.setNewBranch({ from: event.target.value })}
                >
                  {c.newBranch.from === "" && <option value="" disabled />}
                  {c.branches.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* 3. How it lands. */}
        <div className="space-y-2">
          <label
            className={mergeBlocked ? `${radioRowClass} pointer-events-none text-ink-dim` : radioRowClass}
            title={
              status !== null && c.newBranch === null && status.destinationCheckout === "other"
                ? t("finish.dialog.heldElsewhere", { destination: status.destination })
                : status !== null &&
                    status.destinationCheckout === "project" &&
                    status.mergeInProgress
                  ? t("branch.merge.inProgress")
                  : undefined
            }
          >
            <input
              type="radio"
              name={`${ids}-outcome`}
              className="mt-0.5 size-3.5 accent-current"
              checked={c.outcome === "merge"}
              disabled={mergeBlocked}
              onChange={() => c.setOutcome("merge")}
            />
            <span className="min-w-0 space-y-1">
              <span className="block text-ink">
                {t("finish.outcome.merge", { destination: targetName })}
              </span>
              {mergeSublabel()}
            </span>
          </label>
          <label className={radioRowClass}>
            <input
              type="radio"
              name={`${ids}-outcome`}
              className="mt-0.5 size-3.5 accent-current"
              checked={c.outcome === "keep"}
              onChange={() => c.setOutcome("keep")}
            />
            <span className="min-w-0 space-y-1">
              <span className="block text-ink">{t("finish.outcome.keep")}</span>
              <span className={`block ${quietClass}`}>{t("finish.dialog.keepHint")}</span>
              {c.outcome === "keep" && (
                <span className="block">
                  <label htmlFor={`${ids}-rename`} className={labelClass}>
                    {t("finish.dialog.renameLabel")}
                  </label>
                  <input
                    id={`${ids}-rename`}
                    className={fieldClass}
                    value={c.rename}
                    spellCheck={false}
                    onChange={(event) => c.setRename(event.target.value)}
                  />
                </span>
              )}
            </span>
          </label>
        </div>

        {/* 4. What becomes of the session — independent of the two above. */}
        <div>
          <label
            className={radioRowClass}
            title={dirty ? t("finish.dialog.returnBlockedDirty") : undefined}
          >
            <input
              type="checkbox"
              className="size-3.5 accent-current"
              checked={c.returnSession && !dirty}
              disabled={dirty}
              onChange={(event) => c.setReturnSession(event.target.checked)}
            />
            <span className="min-w-0 space-y-1">
              <span className="block text-ink">
                {t("finish.dialog.returnSession", { projectCwd: record.projectCwd })}
              </span>
              <span className={`block ${quietClass}`}>{returnHint()}</span>
            </span>
          </label>
        </div>

        {/* 5. The phase surface: where a stopped merge left the trees, or the
            failure that stopped the run. */}
        {c.phase.s === "conflict" && (
          <div className="space-y-1 rounded-md border border-line bg-raised px-3 py-2.5">
            {c.phase.leftIn === "project" ? (
              <>
                <p className="text-xs leading-relaxed text-copper">
                  {t("finish.dialog.conflictProject", {
                    count: c.phase.files.length,
                    cwd: record.projectCwd,
                  })}
                </p>
                <p className={quietClass}>
                  {t("branch.merge.resolveHint", { cwd: record.projectCwd })}
                </p>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-copper">
                {t("finish.dialog.conflictAborted", { count: c.phase.files.length })}
              </p>
            )}
          </div>
        )}
        {c.phase.s === "error" && (
          <p role="alert" className="text-xs leading-relaxed text-rose">
            {c.phase.message}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
