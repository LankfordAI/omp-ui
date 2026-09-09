import { useEffect, useId, useRef } from "react";
import { useT, type MessageKey } from "../lib/i18n";
import { useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";
import { commitsText, useFinishWorktree, type FinishStep } from "./useFinishWorktree";
import { NEW_BRANCH_SENTINEL } from "./WorktreeBranchFields";

/**
 * The Finish worktree dialog (issues #385–#389, #414): one surface, three
 * independent decisions — where the work goes (destination: resolved base,
 * any local branch, or a new branch cut from a chosen start point), how it
 * lands (merge commit vs keep the branch, optionally renamed), and whether
 * the session returns to the project checkout. The merge is previewed with
 * git merge-tree before anything moves; a predicted conflict offers the
 * sync path so conflicts are resolved in the worktree by the session that
 * owns the change. A dirty checkout cannot be returned — the checkbox says
 * so, and main enforces it. A merged finish ends on the done row instead of
 * closing: the work is landed, and sharing it with the remote stays an
 * explicit step. Supersedes the merge rows the two chips used to carry inline.
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

  // The record vanished (deleted, released elsewhere): the dialog has nothing
  // left to finish. A merged finish releases the session *itself*, and main
  // nulls the record's worktree partway through that call — while the run is
  // in flight or its done row is up, the null is the finish doing its job, not
  // a reason to close: the row still owes the user the choice of sharing what
  // landed (issue #414). Anywhere else, a worktree-less record means the
  // session left the worktree behind someone else's hand.
  const done = c.phase.s === "done";
  const holdsTheFinish = c.phase.s === "working" || done;
  useEffect(() => {
    if (c.record === undefined) closeFinishWorktree();
    else if (c.record.worktree === null && !holdsTheFinish) closeFinishWorktree();
  }, [c.record, holdsTheFinish, closeFinishWorktree]);

  const record = c.record;
  const worktree = record?.worktree ?? null;
  // The branch this dialog names outlives its own release: after a merged
  // finish main has nulled the record's worktree, and the title and the quiet
  // facts still have to say which branch was folded in (issue #414).
  const lastBranchRef = useRef(worktree?.branch ?? "");
  if (worktree !== null) lastBranchRef.current = worktree.branch;
  if (record === undefined) return null;
  const branch = lastBranchRef.current;
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
              disabled={working || done || c.ownRunning || dirty}
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
        {/* The switch variant of the busy row (#431): a new-branch or
            checked-out-nowhere destination moves the project checkout, which is
            what a mid-turn session there cannot tolerate. The mode conditions of
            the two rows are disjoint, so they can never stack. */}
        {c.checkoutTarget !== null && c.busyTitle !== null && (
          <p className={copperClass}>
            {t("finish.dialog.busySwitchProject", {
              title: c.busyTitle,
              destination: c.checkoutTarget,
            })}
          </p>
        )}
      </>
    );
  };

  const returnHint = (): string => {
    if (c.outcome === "merge")
      return c.returnSession
        ? c.checkoutTarget !== null
          ? t("finish.hint.mergeReturnSwitch", { branch, destination: targetName })
          : t("finish.hint.mergeReturn", { branch, destination: targetName })
        : t("finish.hint.mergeStay");
    return c.returnSession
      ? t("finish.hint.keepReturn", { branch })
      : t("finish.hint.keepStay");
  };

  /**
   * The done row's share decision, resolved once so the idle button and the
   * busy confirm cannot disagree (issue #414). What the remote lacks comes off
   * the destination's own upstream: push the count it trails, publish when it
   * has no upstream at all, and offer nothing once it has it all. The mid-turn
   * rule is the branch chip's — an armed confirm pushes on the next click, an
   * unarmed one on a busy checkout only arms.
   */
  const resolveShare = (): { label: string; onClick: () => void } | null => {
    if (c.phase.s !== "done") return null;
    const confirming = c.pushState.s === "confirm";
    if (!confirming && c.pushState.s !== "idle") return null;
    let label: string;
    if (confirming) label = t("composer.branch.pushAnyway");
    else {
      const { destination, destinationAhead, destinationUpstream } = c.phase;
      if (destinationAhead !== null && destinationAhead > 0)
        // The status read reports a count and its ref together; a count with
        // no ref is not a state main returns, and the branch name is the
        // honest fallback for a line that cannot be drawn.
        label = t("finish.done.pushTo", {
          destination,
          commits: commitsText(destinationAhead),
          upstream: destinationUpstream ?? destination,
        });
      else if (destinationAhead === null && c.defaultRemote !== null)
        label = t("finish.done.publishTo", { destination, remote: c.defaultRemote });
      else return null;
    }
    const midTurn = c.busyTitle !== null || c.ownRunning;
    return {
      label,
      onClick: confirming || !midTurn ? () => void c.pushDone() : c.askPushConfirm,
    };
  };
  const donePush = resolveShare();

  return (
    <ConfirmDialog
      kicker={t("finish.dialog.kicker")}
      title={t("finish.dialog.title", { branch })}
      tone="neutral"
      onClose={closeFinishWorktree}
      width="w-[30rem]"
      actions={
        done ? (
          // The finish already happened; the only thing left to decide is
          // whether the landed branch goes to the remote, and that row is in
          // the body, not the footer (issue #414).
          <Button variant="solid" onClick={closeFinishWorktree}>
            {t("finish.primary.done")}
          </Button>
        ) : (
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
        )
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
            // Inert once the run finished (issue #414): picking another
            // destination would re-key the status read and discard the done
            // phase — the session that owed it has already been returned.
            disabled={done}
            value={c.newBranch !== null ? NEW_BRANCH_SENTINEL : (c.destination ?? "")}
            onChange={(event) => {
              if (event.target.value === NEW_BRANCH_SENTINEL) c.chooseNewBranch();
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
            <option value={NEW_BRANCH_SENTINEL}>{t("finish.dialog.newBranchOption")}</option>
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

        {/* 6. The done phase (issue #414): the work is landed locally, and
            sharing it with the remote is a separate, explicit decision —
            push, publish, open a pull request, or close and leave it local. */}
        {c.phase.s === "done" && (
          <div className="space-y-1.5 rounded-md border border-line bg-raised px-3 py-2.5">
            <p className="text-xs leading-snug text-ink">
              {t("finish.done.landed", {
                commits: commitsText(c.phase.commits),
                destination: c.phase.destination,
              })}
            </p>
            {c.pushState.s === "idle" && donePush !== null && (
              <Button size="xs" onClick={donePush.onClick}>
                {donePush.label}
              </Button>
            )}
            {c.pushState.s === "busy" && (
              <Button size="xs" disabled>
                {t("finish.done.pushing")}
              </Button>
            )}
            {c.pushState.s === "confirm" && (
              <>
                {/* The chip's own busy row, in spirit: the mid-turn session is
                    either another tab on this checkout or this one itself. */}
                <p className={copperClass}>
                  {t("composer.branch.confirmPush", { title: c.busyTitle ?? record.title })}
                </p>
                <div className="flex gap-1.5">
                  {donePush !== null && (
                    <Button size="xs" tone="copper" onClick={donePush.onClick}>
                      {donePush.label}
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" onClick={c.dismissPushConfirm}>
                    {t("composer.branch.cancel")}
                  </Button>
                </div>
              </>
            )}
            {c.pushState.s === "settled" && (
              <>
                {c.pushState.result.kind === "pushed" && (
                  <p className={quietClass}>
                    {t("finish.done.pushed", {
                      commits: commitsText(c.pushState.result.commits),
                      upstream: c.pushState.result.upstreamRef,
                    })}
                  </p>
                )}
                {c.pushState.result.kind === "published" && (
                  <p className={quietClass}>
                    {t("finish.done.published", {
                      destination: c.phase.destination,
                      remote: c.pushState.result.remote,
                    })}
                  </p>
                )}
                {c.pushState.result.kind === "up-to-date" && (
                  <p className={quietClass}>
                    {t("composer.branch.upToDate", { upstream: c.pushState.result.upstreamRef })}
                  </p>
                )}
                {/* Git refused a non-fast-forward, so the remote moved: naming
                    the ref it refused against is the whole instruction — pull
                    there, then push again (issue #414). */}
                {c.pushState.result.kind === "rejected" && (
                  <>
                    <p className={copperClass}>
                      {t("finish.done.rejected", {
                        upstream:
                          c.pushState.result.remote === null
                            ? c.phase.destinationUpstream ?? c.phase.destination
                            : `${c.pushState.result.remote}/${c.phase.destination}`,
                      })}
                    </p>
                    <p className={`${quietClass} break-words`}>{c.pushState.result.detail}</p>
                  </>
                )}
                {c.pushState.result.kind === "failed" && (
                  <p role="alert" className="text-xs leading-relaxed text-rose">
                    {c.pushState.result.detail}
                  </p>
                )}
                {/* A pull request only compares anything when the landed
                    destination is not the branch the repo compares on. */}
                {c.pushState.result.kind !== "rejected" &&
                  c.pushState.result.kind !== "failed" &&
                  c.phase.destination !== c.defaultBranch && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void c.openPullRequest()}
                    >
                      {t("finish.done.openPr")}
                    </Button>
                  )}
              </>
            )}
            {c.pushState.s === "failed" && (
              <p role="alert" className="text-xs leading-relaxed text-rose">
                {c.pushState.message}
              </p>
            )}
            {c.prUnavailable && (
              <p className={quietClass}>{t("composer.branch.prUnavailable")}</p>
            )}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}
