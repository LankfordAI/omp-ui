import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MergeBackStatus } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { releaseNoticeLevel, releaseNoticeText, shortBase } from "../lib/format";
import { useDismissal } from "../lib/use-dismissal";
import {
  findRecord,
  runningSessionTitleOnCheckout,
  useStore,
  worktreeSharers,
} from "../store";
import { Button, ConfirmDialog, ICON_STROKE } from "./ui";
import { mintBranchName, WorktreeBranchFields, type WorkspaceSelection } from "./WorktreeBranchFields";

/**
 * The composer's git-branch indicator and switcher (issues #35, #168): a
 * neutral chip showing the project's current branch and how far it trails its
 * configured upstream, opening a filter-as-you-type menu of local branches with
 * a fast-forward pull and a "new branch…" action. Hidden entirely on non-git
 * projects. The composer additionally offers its pending-workspace selection
 * here (issue #227): while the session is unprompted and has no worktree of
 * its own, the menu gains a "worktree…" row whose sub-mode hosts the shared
 * branch/base fields, and the trigger reads the minted branch with a
 * "worktree" marker; its create button cuts the pending worktree now instead
 * of on the first prompt (issue #314), running the same conversion the first
 * send runs. Neutral chrome only — signal mint is reserved for agent
 * liveness (ADR-0004), and neither branch identity nor upstream drift is
 * liveness, so divergence escalates to copper and failures to rose.
 *
 * Upstream reads are transport-only: the store owns every git call, coalesces
 * concurrent refreshes, and keeps the last good snapshot when one fails, so
 * this component never blanks the branch it already showed.
 */

/**
 * Focus and visibility both fire on a single alt-tab back into the window;
 * one short debounce collapses that pair into one network refresh. Staleness
 * beyond this is absorbed by the store's own freshness window.
 */
const NETWORK_REFRESH_DEBOUNCE_MS = 250;

/** The working-tree change awaiting the busy-session confirm. */
type Pending =
  | { kind: "checkout"; branch: string }
  | { kind: "pull" }
  | { kind: "merge" };

const commits = (count: number): string => `${count} commit${count === 1 ? "" : "s"}`;

/** The merge-back row, matching the pull row's mono metrics. */
const mergeRowText =
  "rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-ink-mid hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim";
/** "You must act" guidance inside the branch menu (ADR-0004). */
const copperNote = "px-1.5 py-1 text-[10px] leading-snug text-copper";
/** "Already done" guidance inside the branch menu. */
const quietNote = "px-1.5 py-1 text-[10px] leading-snug text-ink-faint";

export function BranchChip({
  projectCwd,
  workspace,
  onWorkspaceChange,
  workspaceDisabled = false,
  onCreateWorktree,
  mergeBack,
}: {
  projectCwd?: string;
  /**
   * The composer's pending-workspace selection (issue #227), offered only
   * while the session is unprompted and has no worktree of its own. Absent
   * (the default) the popover is the branch menu alone — the compact sheet
   * instance, and every prompted or worktree session.
   */
  workspace?: WorkspaceSelection;
  /**
   * The functional form merges against the latest selection: one event can
   * emit several partial updates (a base pick sets both the ref and the
   * touched latch), and a stale spread would clobber its sibling.
   */
  onWorkspaceChange?: (
    value: WorkspaceSelection | ((prev: WorkspaceSelection) => WorkspaceSelection),
  ) => void;
  /** The composer's session unavailability; disables the worktree rows. */
  workspaceDisabled?: boolean;
  /**
   * Cuts the pending worktree now instead of on the first prompt (issue #314):
   * the composer's shared conversion. Its success lets the popover close; a
   * failure keeps it open for a fix-and-retry, the message in the composer's
   * strip.
   */
  onCreateWorktree?: () => Promise<boolean>;
  /**
   * The session's own worktree merge-back (issue #322): the worktree branch,
   * its recorded base, the project checkout the merge runs in, and the tab
   * to exclude from the project's busy guard. The Composer passes it only
   * for worktree sessions with a non-null base; absent (the default) the
   * popover is the branch menu alone — every plain session and the compact
   * sheet instance.
   */
  mergeBack?: {
    branch: string;
    base: string;
    projectRootCwd: string;
    tabId: string;
  };
}) {
  const info = useStore((s) => (projectCwd === undefined ? undefined : s.branches[projectCwd]));
  const refreshing = useStore(
    (s) => projectCwd !== undefined && s.branchActivity[projectCwd]?.refreshing === true,
  );
  const pulling = useStore(
    (s) => projectCwd !== undefined && s.branchActivity[projectCwd]?.pulling === true,
  );
  const refreshBranches = useStore((s) => s.refreshBranches);
  const checkoutGitBranch = useStore((s) => s.checkoutGitBranch);
  const pullGitBranch = useStore((s) => s.pullGitBranch);
  // A session mid-turn on this checkout: a plain checkout or a fast-forward
  // would move the working tree out from under it, so both earn a confirm.
  const busyTitle = useStore((s) => runningSessionTitleOnCheckout(s, projectCwd));
  const readMergeBackStatus = useStore((s) => s.readMergeBackStatus);
  const mergeWorktreeBranch = useStore((s) => s.mergeWorktreeBranch);
  const appendNotice = useStore((s) => s.appendNotice);
  const releaseWorktreeSession = useStore((s) => s.releaseWorktreeSession);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const consoleIsOpen = useStore((s) =>
    mergeBack === undefined ? false : s.consoleOpen[mergeBack.tabId] === true,
  );
  // A session mid-turn in the PROJECT checkout: the merge moves the
  // destination branch out from under it. The own tab is excluded — the
  // merge never touches this session's worktree checkout.
  const projectBusyTitle = useStore((s) =>
    mergeBack === undefined
      ? null
      : runningSessionTitleOnCheckout(s, mergeBack.projectRootCwd, mergeBack.tabId),
  );
  // The checkout path the return confirms name (issue #334); null for plain
  // sessions and when the record carries no worktree.
  const worktreePath = useStore((s) =>
    mergeBack === undefined
      ? null
      : findRecord(s.state, mergeBack.tabId)?.worktree?.path ?? null,
  );
  // Other sessions in this checkout: while any exist the release keeps the
  // checkout and its branch (issue #334).
  const sharers = useStore((s) =>
    mergeBack === undefined || worktreePath === null
      ? 0
      : worktreeSharers(s.state, mergeBack.tabId, worktreePath).length,
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"list" | "create" | "worktree">("list");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** True while the create-now conversion is in flight (button label). */
  const [cutting, setCutting] = useState(false);
  /** The change awaiting the busy-session confirm; null when not confirming. */
  const [confirm, setConfirm] = useState<Pending | null>(null);
  /** null = not fetched yet, or the fetch rejected (see the error slot). */
  const [mergeStatus, setMergeStatus] = useState<MergeBackStatus | null>(null);
  /** True while the merge is in flight (row label). */
  const [merging, setMerging] = useState(false);
  /** The merge & return confirm modal, portaled outside the popover. */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** The post-merge return phase. */
  const [returning, setReturning] = useState(false);
  /** The return-only confirm (already-merged), portaled outside the popover. */
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  /** Files from a fresh conflicted merge; null when none. */
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);

  /** Wraps the trigger *and* the popover, so one containment test covers both. */
  const rootRef = useRef<HTMLSpanElement>(null);
  /** Focus returns here when Escape closes the popover. */
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeMenu = (): void => {
    setMenuOpen(false);
    setFilter("");
    setMode("list");
    setName("");
    setError(null);
    setConfirm(null);
    setMergeStatus(null);
    setMerging(false);
    setConfirmOpen(false);
    setCloseConfirmOpen(false);
    setReturning(false);
    setConflictFiles(null);
  };

  /**
   * Escape peels one layer at a time: the new-branch form and the busy-session
   * confirm are sub-states of the open popover, not separate surfaces.
   */
  const escapeStage = (): void => {
    if (mode === "create") {
      setMode("list");
      setName("");
      return;
    }
    if (mode === "worktree") {
      setMode("list");
      return;
    }
    if (confirm !== null) {
      setConfirm(null);
      return;
    }
    closeMenu();
  };

  // First paint reads local refs only: mounting a project must not reach the
  // network. Upstream freshness arrives on open, focus, or visibility instead.
  useEffect(() => {
    if (projectCwd !== undefined && info === undefined) {
      void refreshBranches(projectCwd, { fetchUpstream: false });
    }
  }, [projectCwd, info, refreshBranches]);

  // The composer drops the section the moment the session is prompted or
  // converted: a stale worktree sub-mode must not outlive the prop.
  useEffect(() => {
    if (workspace === undefined && mode === "worktree") setMode("list");
  }, [workspace, mode]);

  // Regaining the window is the cheapest honest moment to learn the branch
  // moved elsewhere. Both events fire on one alt-tab, so they share a debounce,
  // and a backgrounded window never spends a fetch.
  useEffect(() => {
    if (projectCwd === undefined) return;
    let timer: number | undefined;
    const scheduleNetworkRefresh = (): void => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshBranches(projectCwd, { fetchUpstream: true });
      }, NETWORK_REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener("focus", scheduleNetworkRefresh);
    document.addEventListener("visibilitychange", scheduleNetworkRefresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", scheduleNetworkRefresh);
      document.removeEventListener("visibilitychange", scheduleNetworkRefresh);
    };
  }, [projectCwd, refreshBranches]);

  // Click-outside / Escape dismissal (issue #114), matching the terminal menu
  // in Sidebar.tsx. The trigger is *inside* rootRef, so a click on it is not an
  // outside click — its own onClick toggles, and the popover closes exactly once.
  useDismissal({
    open: menuOpen,
    refs: rootRef,
    onClose: closeMenu,
    onEscape: escapeStage,
    restoreFocus: () => {
      if (mode === "list" && confirm === null) triggerRef.current?.focus();
    },
    exemptSelector: '[role="alertdialog"]',
  });

  if (projectCwd === undefined || info === undefined || info.repoRoot === null) return null;

  const { current, upstreamRef, hasUpstream, ahead, behind } = info;
  // hasUpstream is the resolution test, not the configuration test: a branch
  // whose remote ref was deleted keeps its configured upstreamRef and loses
  // hasUpstream, and that pair is exactly the "unavailable" state below.
  const resolvable = current !== null && upstreamRef !== null && hasUpstream;
  const diverged = resolvable && ahead > 0 && behind > 0;

  /**
   * The chip's tooltip elaborates only what the chip itself shows: the behind
   * count. Ahead and diverged readings are popover business — the chip stays a
   * quiet indicator rather than a second place to read git state.
   */
  const behindReading =
    resolvable && behind > 0 ? `${commits(behind)} behind ${upstreamRef}` : null;

  /**
   * Every upstream state the pull action cannot serve, explained where the user
   * looked for the action. Behind-only is absent on purpose: the pull row is
   * its own explanation.
   */
  const note: { text: string; tone: "quiet" | "copper" } | null =
    current === null
      ? { text: "detached HEAD — check out a branch to track an upstream", tone: "quiet" }
      : upstreamRef === null
        ? { text: "no upstream configured for this branch", tone: "quiet" }
        : !hasUpstream
          ? { text: `upstream ${upstreamRef} is unavailable`, tone: "copper" }
          : diverged
            ? {
                text: `${ahead} ahead, ${behind} behind ${upstreamRef} — merge or rebase manually`,
                tone: "copper",
              }
            : behind > 0
              ? null
              : ahead > 0
                ? { text: `${commits(ahead)} ahead of ${upstreamRef}`, tone: "quiet" }
                : { text: `up to date with ${upstreamRef}`, tone: "quiet" };

  // The row survives the pull itself: the post-pull refresh zeroes `behind`
  // before `pulling` clears, and a row that vanished mid-operation would read
  // as a silent failure.
  const showPull = pulling || (resolvable && behind > 0);
  const pullEnabled = resolvable && behind > 0 && ahead === 0 && !refreshing && !pulling;
  // The worktree section of the merged chip (issue #227). The branch menu
  // itself is git-level and never disabled; only the worktree rows honour
  // the composer's session readiness.
  const worktreeOffered = workspace !== undefined && onWorkspaceChange !== undefined;
  const worktreeLocked = workspaceDisabled;

  /**
   * Enters the worktree sub-mode. The branch is minted once, on the first
   * pick only — re-picking the active selection keeps the minted name and
   * any edits (issue #225 semantics, preserved).
   */
  const enterWorktree = (): void => {
    if (!worktreeOffered || worktreeLocked) return;
    if (workspace !== undefined && workspace.mode === "worktree") {
      setMode("worktree");
      return;
    }
    onWorkspaceChange?.({ mode: "worktree", branch: mintBranchName(), baseRef: null, baseTouched: false });
    setMode("worktree");
  };

  const pickCheckout = (): void => {
    onWorkspaceChange?.({ mode: "checkout" });
    closeMenu();
  };

  /**
   * Cuts the pending worktree now (issue #314). Success closes the popover; the
   * composer's "cutting the worktree…" strip carries the in-flight status,
   * and a failure leaves the fields open with git's message in that strip.
   */
  const attemptCreate = async (): Promise<void> => {
    if (workspace === undefined || workspace.mode !== "worktree") return;
    if (!onCreateWorktree || cutting || worktreeLocked) return;
    if (workspace.branch.trim() === "") return;
    setCutting(true);
    const ok = await onCreateWorktree();
    setCutting(false);
    if (ok) closeMenu();
  };

  /**
   * Feasibility read; a rejection keeps the status null and lands in the
   * error slot. Re-fetched after every merge attempt so the next render
   * shows the settled git state (already-merged, merge-in-progress, …).
   */
  const fetchStatus = (): void => {
    if (mergeBack === undefined) return;
    readMergeBackStatus(mergeBack.projectRootCwd, mergeBack.branch, mergeBack.base)
      .then(setMergeStatus)
      .catch((err: unknown) => {
        setMergeStatus(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  /** Hands the session back to the project checkout and names the outcome. */
  const runRelease = async (commits: number | null): Promise<boolean> => {
    if (mergeBack === undefined) return false;
    const release = await releaseWorktreeSession(mergeBack.tabId);
    if (release === null) return false;
    appendNotice(
      mergeBack.tabId,
      releaseNoticeText(release, commits),
      releaseNoticeLevel(release),
    );
    return true;
  };

  const toggleMenu = (): void => {
    if (menuOpen) {
      closeMenu();
      return;
    }
    setMenuOpen(true);
    // Fresh list *and* fresh upstream on every open — another tab (or the user
    // in a terminal) may have switched branches, and the remote may have moved.
    void refreshBranches(projectCwd, { fetchUpstream: true });
    fetchStatus();
  };

  const attempt = async (branch: string, create: boolean): Promise<void> => {
    if (!create && branch === current) {
      closeMenu();
      return;
    }
    // The busy confirm guards plain checkout only: `checkout -b` does not move
    // the working tree, so the create flow skips it.
    const restating =
      confirm !== null && confirm.kind === "checkout" && confirm.branch === branch;
    if (!create && busyTitle !== null && !restating) {
      setConfirm({ kind: "checkout", branch });
      return;
    }
    setError(null);
    const err = await checkoutGitBranch(projectCwd, branch, create ? { create: true } : undefined);
    if (err !== null) {
      setError(err);
      setConfirm(null);
      return;
    }
    closeMenu();
  };

  const attemptPull = async (): Promise<void> => {
    if (!pullEnabled) return;
    if (busyTitle !== null && confirm?.kind !== "pull") {
      setConfirm({ kind: "pull" });
      return;
    }
    setError(null);
    const err = await pullGitBranch(projectCwd);
    if (err !== null) {
      setError(err);
      setConfirm(null);
      return;
    }
    closeMenu();
  };

  const onMergeClick = (): void => {
    if (projectBusyTitle !== null && confirm?.kind !== "merge") {
      setConfirm({ kind: "merge" });
      return;
    }
    setConfirmOpen(true);
  };

  /**
   * The console drawer's shell starts in the worktree checkout — the
   * guidance text always carries the project path — so the button only
   * opens an already-closed drawer, never closes one.
   */
  const openConsole = (): void => {
    if (mergeBack !== undefined && !consoleIsOpen) toggleConsole(mergeBack.tabId);
  };

  const runMerge = async (): Promise<void> => {
    const destination = mergeStatus?.destination;
    if (mergeBack === undefined || destination === null || destination === undefined) return;
    setMerging(true);
    let released = false;
    try {
      const result = await mergeWorktreeBranch(
        mergeBack.projectRootCwd,
        mergeBack.branch,
        destination,
      );
      setConfirmOpen(false);
      setConfirm(null);
      if (result.kind === "conflicts") {
        setConflictFiles(result.files);
        const more = result.files.length > 5 ? `, and ${result.files.length - 5} more` : "";
        appendNotice(
          mergeBack.tabId,
          `merge of ${mergeBack.branch} into ${destination} stopped — ${result.files.length} file(s) conflict: ${result.files
            .slice(0, 5)
            .join(", ")}${more}. Resolve in ${mergeBack.projectRootCwd} (git merge --continue) or abort (git merge --abort).`,
          "warn",
        );
      } else {
        // merged / already-merged: the merge is in — hand the session back to
        // the base branch. The record's worktree goes null, so this chip's
        // merge section unmounts on the broadcast.
        setMerging(false);
        setReturning(true);
        released = await runRelease(result.kind === "already-merged" ? null : result.commits);
      }
    } catch (err: unknown) {
      setConfirmOpen(false);
      setConfirm(null);
      setConflictFiles(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // A released session's merge section is about to unmount; only a failure
      // resets the spinner.
      if (!released) {
        setMerging(false);
        setReturning(false);
        fetchStatus();
      }
    }
  };

  const filtered = info.branches.filter((branch) =>
    branch.toLowerCase().includes(filter.toLowerCase()),
  );

  /**
   * The merge-back block (issue #322), first match wins: a disabled
   * pending/merging row, an explanatory note with an escape hatch, or the
   * merge action itself. Copper notes are "you must act"; quiet ones,
   * "already done". The inline busy confirm renders in the popover's
   * confirm sub-state, not here.
   */
  const mergeSection = (): ReactNode => {
    if (mergeBack === undefined) return null;
    if (mergeStatus === null) {
      // Fetch in flight (or rejected — the error slot says so): the row
      // survives, disabled, naming the base as the destination to merge
      // into — and "merging…" while the operation is in flight.
      return (
        <button type="button" role="menuitem" className={mergeRowText} disabled>
          {merging ? "merging…" : `merge into ${shortBase(mergeBack.base)}`}
        </button>
      );
    }
    if (merging || returning) {
      // The row survives the merge and the return it triggers: a row that
      // vanished mid-operation would read as a silent failure (the pull-row
      // pattern).
      return (
        <button type="button" role="menuitem" className={mergeRowText} disabled>
          {returning ? "returning…" : "merging…"}
        </button>
      );
    }
    if (mergeStatus.mergeInProgress) {
      return (
        <>
          <p className={copperNote}>
            a merge is already in progress in the project — finish it there: git merge --continue
            or git merge --abort
          </p>
          <div className="flex gap-1.5 px-1.5 pb-0.5">
            <Button size="xs" variant="ghost" onClick={openConsole}>
              open console
            </Button>
          </div>
        </>
      );
    }
    if (conflictFiles !== null) {
      return (
        <>
          <p className={copperNote}>
            merge stopped — {conflictFiles.length} file(s) conflict
          </p>
          <div className="max-h-24 overflow-y-auto px-1.5 pb-1 font-mono text-[10px] leading-relaxed text-ink-mid">
            {conflictFiles.map((file) => (
              <span key={file} className="block truncate" title={file}>
                {file}
              </span>
            ))}
          </div>
          <p className={quietNote}>
            resolve in {mergeBack.projectRootCwd}, then git merge --continue — or git merge --abort
          </p>
          <div className="flex gap-1.5 px-1.5 pb-0.5">
            <Button size="xs" variant="ghost" onClick={openConsole}>
              open console
            </Button>
          </div>
        </>
      );
    }
    if (!mergeStatus.branchExists) {
      return (
        <p className={copperNote}>
          branch {mergeBack.branch} no longer exists — nothing to merge
        </p>
      );
    }
    if (mergeStatus.destination === null) {
      const short = shortBase(mergeBack.base);
      const text =
        mergeStatus.reason === "base-gone"
          ? `base ${short} no longer resolves — merge manually`
          : mergeStatus.reason === "no-branch-match"
            ? `no local branch matches base ${short} — merge manually`
            : "the project is not a readable git repo — merge manually";
      return <p className={copperNote}>{text}</p>;
    }
    if (!mergeStatus.destinationCheckedOut) {
      return (
        <p className={copperNote}>
          check out {mergeStatus.destination} in the project to merge back
        </p>
      );
    }
    if (mergeStatus.alreadyMerged) {
      return (
        <button
          type="button"
          role="menuitem"
          className={mergeRowText}
          onClick={() => setCloseConfirmOpen(true)}
        >
          return to {mergeStatus.destination}
        </button>
      );
    }
    return (
      <>
        <button type="button" role="menuitem" className={mergeRowText} onClick={onMergeClick}>
          merge into {mergeStatus.destination}
          {mergeStatus.ahead > 0 && (
            <span className="text-ink-faint"> · {commits(mergeStatus.ahead)}</span>
          )}
        </button>
        <p className={quietNote}>
          a successful merge returns this session to {mergeStatus.destination} — the checkout and
          the branch are removed, the session and its transcript are kept
        </p>
      </>
    );
  };

  return (
    <span ref={rootRef} className="relative flex min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={menuOpen}
        title={
          workspace?.mode === "worktree"
            ? `worktree — the first prompt cuts ${workspace.branch} from ${workspace.baseRef ?? "current HEAD"}`
            : behindReading === null
              ? `branch — ${current ?? "detached HEAD"} (click to switch)`
              : `branch — ${current} · ${behindReading} (click to switch)`
        }
        onClick={toggleMenu}
        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-line px-1.5 font-mono text-[10px] leading-4 text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
          <circle cx="5" cy="4" r="1.6" {...ICON_STROKE} />
          <circle cx="5" cy="12" r="1.6" {...ICON_STROKE} />
          <circle cx="11" cy="6" r="1.6" {...ICON_STROKE} />
          <path d="M5 5.6v4.8M11 7.6c0 2.2-2.4 2.4-3.7 3" {...ICON_STROKE} />
        </svg>
        <span className="min-w-0 max-w-44 truncate">
          {workspace?.mode === "worktree" ? workspace.branch : current ?? "detached"}
        </span>
        {workspace?.mode === "worktree" && (
          <span className="shrink-0 text-ink-dim">· worktree</span>
        )}
        {resolvable && behind > 0 && (
          <>
            {/* Behind is a neutral fact; only divergence — where the fix is
                manual — earns copper. The arrow is decoration, so the count
                reaches assistive tech as prose instead. */}
            <span
              aria-hidden
              className={cn("tabular-nums", diverged ? "text-copper" : "text-ink-dim")}
            >
              ↓ {behind}
            </span>
            <span className="sr-only">
              {commits(behind)} behind {upstreamRef}
            </span>
          </>
        )}
      </button>

      {menuOpen && (
        <div
          aria-busy={refreshing || pulling}
          className={cn(
            "animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex flex-col rounded-md border border-line-strong bg-overlay p-1",
            mode === "worktree" ? "w-72" : "w-60",
          )}
        >
          {confirm !== null ? (
            <>
              <div className="px-1.5 py-1 text-[11px] leading-snug text-copper">
                {confirm.kind === "pull"
                  ? `session “${busyTitle}” is mid-turn — pulling changes the project working tree`
                  : confirm.kind === "merge"
                    ? `session “${projectBusyTitle}” is mid-turn in the project — merging moves ${
                        mergeStatus?.destination ?? (mergeBack ? shortBase(mergeBack.base) : "")
                      } under it. The merge also returns this session to ${
                        mergeStatus?.destination ?? (mergeBack ? shortBase(mergeBack.base) : "")
                      }: the checkout and branch are removed, the session is kept.`
                    : `session “${busyTitle}” is mid-turn — the tree will change under it`}
              </div>
              <div className="flex gap-1.5 px-1.5 pb-0.5">
                {confirm.kind === "pull" ? (
                  <Button
                    size="xs"
                    tone="copper"
                    disabled={!pullEnabled}
                    onClick={() => void attemptPull()}
                  >
                    {pulling ? "Pulling…" : "pull anyway"}
                  </Button>
                ) : confirm.kind === "merge" ? (
                  <Button
                    size="xs"
                    tone="copper"
                    disabled={merging || returning}
                    onClick={() => void runMerge()}
                  >
                    {merging ? "merging…" : returning ? "returning…" : "merge & return anyway"}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    tone="copper"
                    onClick={() => void attempt(confirm.branch, false)}
                  >
                    switch anyway
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
                  cancel
                </Button>
              </div>
            </>
          ) : mode === "create" ? (
            <>
              <input
                autoFocus
                value={name}
                placeholder="new-branch-name"
                aria-label="new branch name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim() !== "") {
                    e.preventDefault();
                    void attempt(name.trim(), true);
                  }
                }}
                className="mx-1 mb-1 rounded border border-line bg-void px-1.5 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
              />
              <span className="px-1.5 pb-1 text-[10px] text-ink-faint">
                creates and switches to the branch
              </span>
              <div className="flex gap-1.5 px-1.5 pb-0.5">
                <Button
                  size="xs"
                  disabled={name.trim() === ""}
                  onClick={() => void attempt(name.trim(), true)}
                >
                  create & switch
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setMode("list");
                    setName("");
                  }}
                >
                  back
                </Button>
              </div>
            </>
          ) : mode === "worktree" && workspace?.mode === "worktree" ? (
            <>
              <WorktreeBranchFields
                projectCwd={projectCwd}
                branch={workspace.branch}
                onBranchChange={(branch) => onWorkspaceChange?.({ ...workspace, branch })}
                baseRef={workspace.baseRef}
                onBaseRefChange={(baseRef) =>
                  onWorkspaceChange?.((prev) =>
                    prev.mode === "worktree" ? { ...prev, baseRef } : prev,
                  )
                }
                baseTouched={workspace.baseTouched}
                onBaseTouchedChange={(baseTouched) =>
                  onWorkspaceChange?.((prev) =>
                    prev.mode === "worktree" ? { ...prev, baseTouched } : prev,
                  )
                }
                idPrefix="composer-worktree"
              />
              <span className="px-1.5 pb-1 text-[10px] text-ink-faint">
                create it now, or the first prompt cuts it
              </span>
              <div className="flex gap-1.5 px-1.5 pb-0.5">
                {onCreateWorktree !== undefined && (
                  <Button
                    size="xs"
                    disabled={cutting || worktreeLocked || workspace.branch.trim() === ""}
                    onClick={() => void attemptCreate()}
                  >
                    {cutting ? "creating…" : "create"}
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => setMode("list")}>
                  back
                </Button>
              </div>
            </>
          ) : (
            <>
              {mergeSection()}
              {showPull && (
                <button
                  type="button"
                  disabled={!pullEnabled}
                  onClick={() => void attemptPull()}
                  className="rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-ink hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim"
                >
                  {pulling ? "Pulling…" : `pull ${commits(behind)}`}
                </button>
              )}
              {note !== null && (
                <div
                  className={cn(
                    "px-1.5 py-1 text-[10px] leading-snug",
                    note.tone === "copper" ? "text-copper" : "text-ink-faint",
                  )}
                >
                  {note.text}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setMode("create");
                  setError(null);
                }}
                className="rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-ink-mid hover:bg-hover"
              >
                new branch…
              </button>
              {workspace?.mode === "worktree" && (
                <button
                  type="button"
                  disabled={worktreeLocked}
                  onClick={pickCheckout}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                    "disabled:pointer-events-none disabled:text-ink-dim",
                  )}
                >
                  Current checkout
                </button>
              )}
              {worktreeOffered && (
                <button
                  type="button"
                  disabled={worktreeLocked}
                  title={
                    worktreeLocked
                      ? "the session must be ready before it can run in a worktree"
                      : undefined
                  }
                  onClick={enterWorktree}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                    // No pointer-events-none: the disabled state carries its
                    // hint as a tooltip, which hover must still reach.
                    "disabled:text-ink-dim disabled:hover:bg-transparent",
                    workspace?.mode === "worktree" ? "text-iris" : "text-ink-mid",
                  )}
                >
                  worktree…
                </button>
              )}
              <input
                autoFocus
                value={filter}
                placeholder="filter branches…"
                aria-label="filter branches"
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filtered.length > 0) {
                    e.preventDefault();
                    void attempt(filtered[0]!, false);
                  }
                }}
                className="mx-1 mb-1 rounded border border-line bg-void px-1.5 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
              />
              <div className="flex max-h-64 flex-col overflow-y-auto">
                {filtered.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    disabled={branch === current}
                    onClick={() => void attempt(branch, false)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                      "disabled:pointer-events-none",
                      branch === current ? "text-iris" : "text-ink-mid",
                    )}
                  >
                    {branch}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <span className="px-1.5 py-0.5 font-mono text-[11px] text-ink-faint">
                    no matches
                  </span>
                )}
              </div>
            </>
          )}
          {/* A background fetch that failed is not worth interrupting anyone
              for — it surfaces here, quietly, only once the popover is open. */}
          {refreshing && (
            <div className="px-1.5 py-1 text-[10px] text-ink-faint">refreshing upstream…</div>
          )}
          {info.upstreamRefreshError !== null && !refreshing && (
            <div className="break-words px-1.5 py-1 text-[10px] leading-snug text-rose">
              {info.upstreamRefreshError}
            </div>
          )}
          {error !== null && (
            <div className="break-words px-1.5 py-1 text-[11px] text-rose">{error}</div>
          )}
        </div>
      )}
      {confirmOpen && mergeBack !== undefined && worktreePath !== null && mergeStatus !== null && mergeStatus.destination !== null && (
        <ConfirmDialog
          kicker="Irreversible action"
          tone="rose"
          width="w-[28rem]"
          title={`Merge ${mergeBack.branch} into ${mergeStatus.destination} and return this session to it?`}
          onClose={() => setConfirmOpen(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                cancel
              </Button>
              <Button
                variant="solid"
                tone="rose"
                disabled={merging || returning}
                onClick={() => void runMerge()}
              >
                {merging ? "merging…" : returning ? "returning…" : "merge & return"}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p>
              Writes a merge commit in the project checkout recording the {mergeStatus.ahead}{" "}
              committed change(s) on {mergeBack.branch} — their subjects and any issues they close.
              Uncommitted changes in the worktree are not included.
            </p>
            <p>
              This session then returns to {mergeStatus.destination} in {mergeBack.projectRootCwd}:
              its agent restarts there with its transcript intact. The checkout {worktreePath} is
              removed — uncommitted changes there are lost — and the branch {mergeBack.branch} is
              deleted.
            </p>
            {sharers > 0 && (
              <p>
                {sharers} other session(s) still run in this checkout, so it and the branch are kept
                until they leave.
              </p>
            )}
            <p>
              A conflicted merge stops both the merge and the return: the project checkout is left
              with files to resolve, and this session stays on {mergeBack.branch}.
            </p>
          </div>
        </ConfirmDialog>
      )}
      {closeConfirmOpen && mergeBack !== undefined && worktreePath !== null && mergeStatus !== null && mergeStatus.destination !== null && (
        <ConfirmDialog
          kicker="Irreversible action"
          tone="rose"
          width="w-[28rem]"
          title={`Return this session to ${mergeStatus.destination}?`}
          onClose={() => setCloseConfirmOpen(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setCloseConfirmOpen(false)}>
                cancel
              </Button>
              <Button
                variant="solid"
                tone="rose"
                disabled={returning}
                onClick={() => {
                  void (async () => {
                    setCloseConfirmOpen(false);
                    setReturning(true);
                    if (!(await runRelease(null))) {
                      setReturning(false);
                      fetchStatus();
                    }
                  })();
                }}
              >
                {returning ? "returning…" : `return to ${mergeStatus.destination}`}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p>The branch {mergeBack.branch} is already in {mergeStatus.destination}.</p>
            <p>
              This session returns to {mergeStatus.destination} in {mergeBack.projectRootCwd}: its
              agent restarts there with its transcript intact. The checkout {worktreePath} is
              removed — uncommitted changes there are lost — and the branch {mergeBack.branch} is
              deleted.
            </p>
            {sharers > 0 && (
              <p>
                {sharers} other session(s) still run in this checkout, so it and the branch are kept
                until they leave.
              </p>
            )}
          </div>
        </ConfirmDialog>
      )}
    </span>
  );
}
