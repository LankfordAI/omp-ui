import { useEffect, useId, useRef } from "react";
import { relativeTime } from "../lib/format";
import { occupantActivityPhrase, useStore } from "../store";
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
 * so, and main enforces it. Tracked changes omp's git guard saved before a
 * git command in the worktree discarded them (omp 18.14, issue #973) are
 * listed with a restore action that re-applies one into the checkout. A
 * merged finish ends on the done row instead of closing: the work is landed,
 * sharing it with the remote stays an explicit step, and the session stays
 * live under the row until it is dismissed — dismissal settles through the
 * shared settle action (issue #1061). Supersedes the merge rows the two
 * chips used to carry inline.
 */

const stepLabel: Record<FinishStep, string> = {
  creating: "creating branch…",
  renaming: "renaming…",
  merging: "merging…",
  syncing: "syncing…",
  returning: "returning…",
  restoring: "restoring…",
};

const fieldClass =
  "mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-line-strong";
const labelClass = "block text-xs text-ink-faint";
const quietClass = "text-xs leading-snug text-ink-faint";
const copperClass = "text-xs leading-snug text-copper";
const radioRowClass =
  "flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink has-[:checked]:border-line-strong has-[:checked]:text-ink";

export function FinishWorktreeDialog({ tabId }: { tabId: string }) {
  const c = useFinishWorktree(tabId);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const abortAgent = useStore((s) => s.abortAgent);
  const openSession = useStore((s) => s.openSession);
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
  const holdsTheFinish = c.phase.s === "working" || done || c.resolutionBusy;
  useEffect(() => {
    if (c.record === undefined) c.close();
    else if (c.record.worktree === null && !holdsTheFinish) c.close();
  }, [c.record, holdsTheFinish, c.close]);

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
  const sameBranch = c.newBranch === null && targetName !== "" && targetName === branch;
  const mergeBlocked = c.mergeBlocked;

  const working = c.phase.s === "working";
  const blockerTab = c.resolution?.blockedByTabId ?? null;
  const label =
    c.phase.s === "loading"
      ? "checking the repo…"
      : c.phase.s === "working"
        ? stepLabel[c.phase.step]
        : (c.primaryLabel ?? "nothing to do");

  const mergeSublabel = (): React.ReactNode => {
    if (status === null) return null;
    if (status.alreadyMerged)
      return (
        <p className={quietClass}>
          {sameBranch
            ? `commits are already on ${branch}; returning keeps the branch`
            : `the branch ${branch} is already in ${targetName}`}
        </p>
      );
    if (c.newBranch === null && status.destinationCheckout === "other")
      return <p className={copperClass}>{`${targetName} is checked out in another worktree — pick another destination`}</p>;
    if (c.newBranch === null && status.destinationCheckout === "project" && status.mergeInProgress)
      return <p className={copperClass}>a merge is already in progress in the project — finish it there: git merge --continue or git merge --abort</p>;
    const preview = status.preview;
    // blind to these files, and git refuses the merge on them before any
    // strategy runs. They take the row over — "no conflicts predicted"
    // beside a merge that cannot start is exactly what this issue reported.
    // A null list inside THIS scope — a merge that would really run in the
    // project checkout — means the read FAILED: unknown, which says so
    // plainly instead of signing the preview as certified-clean. Outside it
    // (new branch, or a start point held nowhere) the null means "no live
    // tree at stake", never unknown. git's own guard stays the authority.
    const overlapVisible = c.newBranch === null && status.destinationCheckout === "project";
    const destinationDirty = overlapVisible ? (c.destinationDirtyFiles ?? []) : [];
    const destinationDirtyUnknown =
      overlapVisible && status.destinationDirtyFiles === null;
    return (
      <>
        {destinationDirty.length > 0 && (
          <>
            <p className={copperClass}>the project checkout has uncommitted changes to files this merge would overwrite — commit or stash them in the project checkout first</p>
            <ul className="mt-1 space-y-0.5">
              {destinationDirty.slice(0, 5).map((file) => (
                <li key={file} className="truncate font-mono text-xs text-copper" title={file}>
                  {file}
                </li>
              ))}
              {destinationDirty.length > 5 && (
                <li className={quietClass}>{`+${destinationDirty.length - 5} more`}</li>
              )}
            </ul>
          </>
        )}
        {destinationDirtyUnknown && (
          <p className={copperClass}>the project checkout's working tree could not be read — the merge may still stop there; commit or stash local edits to be sure</p>
        )}
        {preview.kind === "clean" && destinationDirty.length === 0 && !destinationDirtyUnknown && (
          <p className={quietClass}>no conflicts predicted</p>
        )}
        {preview.kind === "unknown" && <p className={quietClass}>this git cannot predict conflicts — the merge may still stop</p>}
        {preview.kind === "conflicts" && (
          <>
            <p className={copperClass}>
              {`${preview.files.length} file(s) would conflict`}
            </p>
            <ul className="mt-1 space-y-0.5">
              {preview.files.slice(0, 5).map((file) => (
                <li key={file} className="truncate font-mono text-xs text-copper" title={file}>
                  {file}
                </li>
              ))}
              {preview.files.length > 5 && (
                <li className={quietClass}>{`+${preview.files.length - 5} more`}</li>
              )}
            </ul>
            <Button
              size="xs"
              variant="ghost"
              className="mt-1"
              disabled={working || done || c.resolutionBusy || c.ownRunning || dirty}
              title={
                c.ownRunning
                  ? "this session is mid-turn — pause it before syncing"
                  : dirty
                    ? "the checkout is dirty — commit or discard before syncing"
                    : undefined
              }
              onClick={() => void c.sync()}
            >
              {`sync ${c.newBranch === null ? targetName : c.newBranch.from} into the worktree`}
            </Button>
          </>
        )}
        {c.newBranch === null &&
          status.destinationCheckout === "project" &&
          c.occupant !== null && (
            <p className={copperClass}>
              {`session “${c.occupant.title}” ${occupantActivityPhrase(c.occupant.reason)} — merging moves ${targetName} under it`}
            </p>
          )}
        {/* The switch variant of the busy row (#431): a new-branch or
            checked-out-nowhere destination moves the project checkout, which is
            what another active session there cannot tolerate. The mode conditions of
            the two rows are disjoint, so they can never stack. */}
        {c.checkoutTarget !== null && c.occupant !== null && (
          <p className={copperClass}>
            {`session “${c.occupant.title}” ${occupantActivityPhrase(c.occupant.reason)} — returning would move its checkout to ${c.checkoutTarget}, so the checkout is left alone`}
          </p>
        )}
      </>
    );
  };

  const returnHint = (): string => {
    if (c.outcome === "merge")
      return c.returnSession
        ? sameBranch
          ? `the checkout is removed; the branch ${branch} stays`
          : c.checkoutTarget !== null
            ? `the checkout is removed, the branch ${branch} deleted once it is in ${targetName}, and this session returns on ${targetName}`
            : `the checkout is removed and the branch ${branch} deleted once it is in ${targetName}`
        : `the session stays in its checkout on ${branch}`;
    return c.returnSession
      ? `the checkout is removed; the branch ${branch} stays`
      : "nothing changes in git; the session keeps running here";
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
    if (confirming) label = "push anyway";
    else {
      const { destination, destinationAhead, destinationUpstream } = c.phase;
      if (destinationAhead !== null && destinationAhead > 0)
        // The status read reports a count and its ref together; a count with
        // no ref is not a state main returns, and the branch name is the
        // honest fallback for a line that cannot be drawn.
        label = `push ${destination} — ${commitsText(destinationAhead)} to ${destinationUpstream ?? destination}`;
      else if (destinationAhead === null && c.defaultRemote !== null)
        label = `publish ${destination} to ${c.defaultRemote}`;
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
      kicker="Finish worktree"
      title={`Finish ${branch}?`}
      tone="neutral"
      onClose={c.close}
      androidBack={done ? "block" : "dismiss"}
      width="w-[30rem]"
      actions={
        done ? (
          // The finish already happened; the only thing left to decide is
          // whether the landed branch goes to the remote, and that row is in
          // the body, not the footer (issue #414).
          <Button
            variant="solid"
            disabled={c.resolutionBusy || c.pushState.s === "busy"}
            onClick={c.close}
          >
            done
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={c.resolutionBusy || working || c.phase.s === "loading"}
              onClick={c.close}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              tone={c.returnSession ? "rose" : "neutral"}
              disabled={c.primaryLabel === null || working || c.resolutionBusy || c.phase.s === "loading"}
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
              : sameBranch
                ? `this worktree is on ${branch} — nothing to merge`
                : status.alreadyMerged
                  ? `the branch ${branch} is already in ${targetName}`
                  : `${status.ahead === 1 ? `${status.ahead} commit` : `${status.ahead} commits`} ahead of ${targetName}, ${status.behind} behind`}
          </p>
          {dirty && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs leading-snug text-copper">uncommitted changes in the checkout — commit them, or discard them, before returning</p>
              <Button
                size="xs"
                variant="ghost"
                disabled={c.resolutionBusy}
                onClick={() => {
                  if (!consoleIsOpen) toggleConsole(tabId);
                }}
              >
                open console
              </Button>
            </div>
          )}
          {c.sharers > 0 && (
            <p className="text-xs leading-snug text-ink-faint">
              {`${c.sharers} other session(s) still run in this checkout, so it and the branch are kept until they leave.`}
            </p>
          )}
        </div>

        {/* 1b. What omp's git guard saved before a git command in the worktree
            discarded it (issue #973): each save re-applies with
            git stash apply --index, staged changes staged again. */}
        {c.discarded.length > 0 && !done && (
          <section className="space-y-1.5 rounded-md border border-line bg-raised px-3 py-2.5">
            <p className="text-xs text-ink">{`discarded changes omp saved (${c.discarded.length})`}</p>
            <p className={quietClass}>omp's git guard saved these before a git command in this worktree discarded them; untracked files are never saved, and saves expire with git's reflog</p>
            <ul className="space-y-1">
              {c.discarded.slice(0, 5).map((save) => (
                <li key={save.commit} className="flex items-center justify-between gap-2">
                  <span className="min-w-0" title={save.files.join("\n")}>
                    <span className="block truncate font-mono text-xs text-ink-mid">
                      {`${save.command === "" ? save.commit.slice(0, 7) : save.command} on ${save.branch}`}
                    </span>
                    <span className={`block ${quietClass}`}>
                      {save.commit.slice(0, 7)} · {relativeTime(new Date(save.savedAt).toISOString())} ·{" "}
                      {`${save.files.length} file(s)`}
                    </span>
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={working || c.resolutionBusy || c.ownRunning}
                    title={c.ownRunning ? "this session is mid-turn — pause it before restoring" : undefined}
                    onClick={() => void c.restoreDiscarded(save.commit)}
                  >
                    restore
                  </Button>
                </li>
              ))}
              {c.discarded.length > 5 && (
                <li className={quietClass}>{`+${c.discarded.length - 5} more`}</li>
              )}
            </ul>
          </section>
        )}

        {/* 2. How it lands — peer outcomes: Push & PR (keep branch) and Merge. */}
        <div className="space-y-2">
          <label className={radioRowClass}>
            <input
              type="radio"
              name={`${ids}-outcome`}
              className="mt-0.5 size-3.5 accent-current"
              checked={c.outcome === "keep"}
              disabled={done || c.resolutionBusy}
              onChange={() => c.setOutcome("keep")}
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-ink">Push &amp; PR (keep branch)</span>
              <span className={`block ${quietClass}`}>the branch survives the finish; rename it, then publish or open a pull request</span>
              {c.outcome === "keep" && (
                <span className="block">
                  <label htmlFor={`${ids}-rename`} className={labelClass}>
                    rename branch to
                  </label>
                  <input
                    id={`${ids}-rename`}
                    className={fieldClass}
                    value={c.rename}
                    spellCheck={false}
                    disabled={done || c.resolutionBusy}
                    onChange={(event) => c.setRename(event.target.value)}
                  />
                </span>
              )}
            </span>
          </label>
          <label
            className={mergeBlocked ? `${radioRowClass} pointer-events-none text-ink-dim` : radioRowClass}
            title={
              !mergeBlocked
                ? undefined
                : status !== null && c.newBranch === null && status.destinationCheckout === "other"
                  ? `${status.destination} is checked out in another worktree — pick another destination`
                  : status !== null &&
                      status.destinationCheckout === "project" &&
                      status.mergeInProgress
                    ? "a merge is already in progress in the project — finish it there: git merge --continue or git merge --abort"
                    : (c.destinationDirtyFiles?.length ?? 0) > 0
                      ? "the project checkout has uncommitted changes to files this merge would overwrite — commit or stash them in the project checkout first"
                      : undefined
            }
          >
            <input
              type="radio"
              name={`${ids}-outcome`}
              className="mt-0.5 size-3.5 accent-current"
              checked={c.outcome === "merge"}
              disabled={done || mergeBlocked || c.resolutionBusy}
              onChange={() => c.setOutcome("merge")}
            />
            <span className="min-w-0 space-y-1">
              <span className="block text-ink">
                {sameBranch ? `finish on ${branch}` : `merge into ${targetName}`}
              </span>
              {mergeSublabel()}
            </span>
          </label>
        </div>

        {/* 3. Where the work goes — hidden when keeping the branch unless blocked fallback or new-branch creation is active. */}
        {(c.outcome === "merge" || mergeBlocked || c.newBranch !== null) && (
          <div>
            <label htmlFor={`${ids}-dest`} className={labelClass}>
              where the work goes
            </label>
            <select
              id={`${ids}-dest`}
              className={fieldClass}
              // Inert once the run finished (issue #414): picking another
              // destination would re-key the status read and discard the done
              // phase — the session that owed it has already been returned.
              disabled={done || c.resolutionBusy}
              value={c.newBranch !== null ? NEW_BRANCH_SENTINEL : (c.destination ?? "")}
              onChange={(event) => {
                if (event.target.value === NEW_BRANCH_SENTINEL) c.chooseNewBranch();
                else c.setDestination(event.target.value);
              }}
            >
              {c.destination === null && c.newBranch === null && (
                <option value="" disabled>
                  checking the repo…
                </option>
              )}
              {c.destination !== null && !c.branches.includes(c.destination) && (
                <option value={c.destination}>{c.destination}</option>
              )}
              {c.branches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              <option value={NEW_BRANCH_SENTINEL}>new branch…</option>
            </select>
            {c.newBranch !== null && (
              <div className="mt-2 space-y-2">
                <div>
                  <label htmlFor={`${ids}-nb-name`} className={labelClass}>
                    branch name
                  </label>
                  <input
                    id={`${ids}-nb-name`}
                    className={fieldClass}
                    value={c.newBranch.name}
                    placeholder="release/next"
                    spellCheck={false}
                    disabled={c.resolutionBusy}
                    onChange={(event) => c.setNewBranch({ name: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor={`${ids}-nb-from`} className={labelClass}>
                    cut from
                  </label>
                  <select
                    id={`${ids}-nb-from`}
                    className={fieldClass}
                    value={c.newBranch.from}
                    disabled={c.resolutionBusy}
                    onChange={(event) => c.setNewBranch({ from: event.target.value })}
                  >
                    {c.newBranch.from === "" && <option value="" disabled />}
                    {c.newBranch.from !== "" && !c.branches.includes(c.newBranch.from) && (
                      <option value={c.newBranch.from}>{c.newBranch.from}</option>
                    )}
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
        )}

        {/* 4. What becomes of the session — independent of the two above. */}
        <div>
          <label
            className={radioRowClass}
            title={dirty ? "the checkout is dirty — commit or discard the changes first" : undefined}
          >
            <input
              type="checkbox"
              className="size-3.5 accent-current"
              checked={c.returnSession && !dirty}
              disabled={dirty || c.resolutionBusy}
              onChange={(event) => c.setReturnSession(event.target.checked)}
            />
            <span className="min-w-0 space-y-1">
              <span className="block text-ink">
                {`return this session to ${record.projectCwd}`}
              </span>
              <span className={`block ${quietClass}`}>{returnHint()}</span>
            </span>
          </label>
        </div>

        {/* 5. The phase surface: where a stopped merge left the trees, or the
            failure that stopped the run. */}
        {(c.phase.s === "conflict" || c.resolution !== null) && (
          <section className="space-y-2 rounded-md border border-line bg-raised px-3 py-2.5">
            {c.phase.s === "conflict" && (
              <p className="text-xs leading-relaxed text-copper">
                {c.phase.leftIn === "project"
                  ? `the merge stopped on ${c.phase.files.length} file(s) in the project checkout — nothing was returned`
                  : `nothing was changed — ${c.phase.files.length} file(s) would conflict. Sync first, resolve in the worktree, then finish again`}
              </p>
            )}
            {c.resolution !== null && (
              <>
                {c.resolution.startsMerge ? (
                  <p className={copperClass}>
                    {`This starts the merge of ${branch} into ${c.status?.destination ?? ""} in the project checkout. If it stops on conflicts, the agent resolves them there; if it lands clean, it simply finishes the merge.`}
                  </p>
                ) : (
                  !(c.phase.s === "conflict" && c.phase.leftIn === "project") && (
                    <p className={copperClass}>a merge is already in progress in the project — finish it there: git merge --continue or git merge --abort</p>
                  )
                )}
                <p className={`${quietClass} [overflow-wrap:anywhere]`}>
                  {c.resolution.route === "current" ? `Send this task to this session. It will resolve the merge in ${c.resolution.trigger.cwd}, not its worktree. Nothing will be pushed or returned.` : `Start a new native resolution session in ${c.resolution.trigger.cwd}. Your original session and worktree stay unchanged. Nothing will be pushed or returned.`}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    variant={c.resolution.blockedReason !== null ? "outline" : "ghost"}
                    tone="copper"
                    disabled={c.resolutionBusy || working || c.resolution.blockedReason !== null}
                    onClick={() => void c.resolveWithAgent()}
                  >
                    {c.resolutionBusy ? "Sending resolution task…" : "Resolve with agent"}
                  </Button>
                  {c.resolution.blockedReason !== null && (
                    <p className={`${copperClass} min-w-0`}>{c.resolution.blockedReason}</p>
                  )}
                </div>
                {blockerTab !== null && (
                  <div className="flex gap-1.5">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={c.resolutionBusy || working}
                      onClick={() => void abortAgent(blockerTab)}
                    >
                      Stop that turn
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={c.resolutionBusy || working}
                      onClick={() => {
                        void openSession(blockerTab);
                        c.close();
                      }}
                    >
                      Open that session
                    </Button>
                  </div>
                )}
                {c.resolutionError !== null && (
                  <p role="alert" className="text-xs leading-relaxed text-rose">
                    {c.resolutionError}
                  </p>
                )}
                <p className={`${quietClass} [overflow-wrap:anywhere]`}>
                  {`resolve in ${c.resolution.trigger.cwd}, then git merge --continue — or git merge --abort`}
                </p>
              </>
            )}
          </section>
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
              {c.phase.kind === "kept"
                ? `kept branch ${c.phase.branch}`
                : `merged ${commitsText(c.phase.commits)} into ${c.phase.destination}`}
            </p>
            {c.pushState.s === "idle" && donePush !== null && (
              <Button size="xs" onClick={donePush.onClick}>
                {donePush.label}
              </Button>
            )}
            {c.pushState.s === "busy" && (
              <Button size="xs" disabled>
                pushing…
              </Button>
            )}
            {c.pushState.s === "confirm" && (
              <>
                {/* The chip's own busy row, in spirit: the mid-turn session is
                    either another tab on this checkout or this one itself. */}
                <p className={copperClass}>
                  {`session “${c.occupant?.title ?? record.title}” ${occupantActivityPhrase(c.occupant?.reason ?? "running")} — the branch is shared as it stands`}
                </p>
                <div className="flex gap-1.5">
                  {donePush !== null && (
                    <Button size="xs" tone="copper" onClick={donePush.onClick}>
                      {donePush.label}
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" onClick={c.dismissPushConfirm}>
                    cancel
                  </Button>
                </div>
              </>
            )}
            {c.pushState.s === "settled" && (
              <>
                {c.pushState.result.kind === "pushed" && (
                  <p className={quietClass}>
                    {`pushed ${commitsText(c.pushState.result.commits)} to ${c.pushState.result.upstreamRef}`}
                  </p>
                )}
                {c.pushState.result.kind === "published" && (
                  <p className={quietClass}>
                    {`published ${c.phase.destination} to ${c.pushState.result.remote}`}
                  </p>
                )}
                {c.pushState.result.kind === "up-to-date" && (
                  <p className={quietClass}>
                    {`up to date with ${c.pushState.result.upstreamRef}`}
                  </p>
                )}
                {/* Git refused a non-fast-forward, so the remote moved: naming
                    the ref it refused against is the whole instruction — pull
                    there, then push again (issue #414). */}
                {c.pushState.result.kind === "rejected" && (
                  <>
                    <p className={copperClass}>
                      {`${c.pushState.result.remote === null
                            ? c.phase.destinationUpstream ?? c.phase.destination
                            : `${c.pushState.result.remote}/${c.phase.destination}`} has commits this branch lacks — pull first, then push`}
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
                  c.phase.destination !== c.defaultBranch &&
                  (c.prOpened ? (
                    <p className={`${quietClass} [overflow-wrap:anywhere]`}>
                      {`compare page for ${c.phase.destination} opened in your browser`}
                    </p>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void c.openPullRequest()}
                    >
                      open pull request
                    </Button>
                  ))}
              </>
            )}
            {c.pushState.s === "failed" && (
              <p role="alert" className="text-xs leading-relaxed text-rose">
                {c.pushState.message}
              </p>
            )}
            {c.prUnavailable && (
              <p className={quietClass}>cannot build a pull-request URL for this remote</p>
            )}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}
