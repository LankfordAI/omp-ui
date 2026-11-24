import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { projectKey } from "../lib/project-key";
import type { GitResolutionTrigger } from "../lib/git-resolution-prompt";
import { useDismissal } from "../lib/use-dismissal";
import { checkoutOccupant, findWorktreeHolderSession, occupantActivityPhrase, useStore } from "../store";
import { Button, ICON_STROKE } from "./ui";
import {
  baseBranchSegment,
  mintBranchName,
  worktreeBranchPrefix,
} from "@omp-ui/core/worktree-branch";
import { WorktreeBranchFields, type WorkspaceSelection } from "./WorktreeBranchFields";

/**
 * The composer's git-branch indicator and switcher (issues #35, #168): a
 * neutral chip showing the project's current branch and how far it trails its
 * configured upstream, opening a filter-as-you-type menu of local branches with
 * a fast-forward pull, a push or first-publish of the checked-out branch, and a
 * pull-request link (issue #414), plus a "new branch…" action. Hidden entirely
 * on non-git projects. The composer additionally offers its pending-workspace
 * here (issue #227): while the session is unprompted and has no worktree of
 * its own, the menu gains a "worktree…" row whose sub-mode hosts the shared
 * branch/base fields, and the trigger reads the minted branch with a
 * "worktree" marker; its create button cuts the pending worktree now instead
 * of on the first prompt (issue #314), running the same conversion the first
 * send runs. Neutral chrome only — signal mint is reserved for agent
 * liveness (ADR-0004), and neither branch identity nor upstream drift is
 * liveness, so divergence escalates to copper and failures to rose. A
 * diverged or mid-merge checkout also offers an agent-resolution row (issue
 * #675): clicking it spawns a session in that checkout seeded with the
 * resolution playbook.
 *
 * Upstream reads are transport-only: the store owns every git call, coalesces
 * concurrent refreshes, and keeps the last good snapshot when one fails, so
 * this component never blanks the branch it already showed.
 */

/**
 * Focus and visibility both fire on a single alt-tab back into the window;
 * one short debounce collapses that pair into one network refresh. Checkout
 * staleness is absorbed by the store's branch:changed subscription (#498):
 * the owner's git handlers emit it, the owner's gitdir watcher catches
 * terminal git, and a joiner re-stamps a host's event with the host's
 * instance id. That path reads local refs only — the upstream network read
 * this debounce exists for stays on the focus/menu paths.
 */
const NETWORK_REFRESH_DEBOUNCE_MS = 250;

/** While the window stays visible, re-check upstream this often (issue #708).
 * Must stay >= the core's FETCH_FRESH_MS: staggered ticks from several chips
 * only coalesce there, so a shorter interval would spend real fetches. */
const NETWORK_POLL_INTERVAL_MS = 60_000;

/** The checkout, pull, or push awaiting the busy-session confirm. */
type Pending =
  | { kind: "checkout"; branch: string; create: boolean }
  | { kind: "pull" }
  | { kind: "push"; branch: string }
  | { kind: "resolve" };
export interface BranchChipExternalRequest {
  /** Monotonic nonce so repeated clicks re-trigger the effect. */
  nonce: number;
  confirmPull?: boolean;
  error?: string | null;
  close?: boolean;
}

export function BranchChip({
  tabId,
  projectCwd,
  instanceId = null,
  workspace,
  onWorkspaceChange,
  workspaceDisabled = false,
  onCreateWorktree,
  finishTabId,
  externalRequest,
  placement = "float",
  density = "desktop",
  triggerVariant = "chip",
  joinRight = false,
  onMenuOpen,
}: {
  /** Optional owning tab id (used to convert an unprompted session into an existing-branch worktree). */
  tabId?: string;
  projectCwd?: string;
  /** The remote instance owning the checkout (issue #416); null for this host. */
  instanceId?: string | null;
  placement?: "float" | "flow";
  /** `touch` applies 44px mobile touch targets. */
  density?: "desktop" | "touch";
  /** `strip` renders as a composer strip cap beside the prompt-options button. */
  triggerVariant?: "chip" | "strip";
  /** Strip-only: square the right corners when a pull cap sits to the right. */
  joinRight?: boolean;
  /** Called when the BranchChip popover opens (used for mutual exclusion with prompt options). */
  onMenuOpen?: () => void;
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
   * The tab whose Finish worktree dialog this session's worktree belongs to
   * (issues #385–#389): the Composer passes its own tab for worktree
   * sessions; absent (the default) the popover is the branch menu alone.
   */
  finishTabId?: string;
  externalRequest?: BranchChipExternalRequest | null;
}) {
  /** The drift count as prose: "3 commits" / "1 commit". */
  const commits = (count: number): string =>
    `${count} ${count === 1 ? "commit" : "commits"}`;
  const key = projectCwd === undefined ? undefined : projectKey(instanceId, projectCwd);
  const info = useStore((s) => (key === undefined ? undefined : s.branches[key]));
  const refreshing = useStore(
    (s) => key !== undefined && s.branchActivity[key]?.refreshing === true,
  );
  const fetching = useStore(
    (s) => key !== undefined && s.branchActivity[key]?.fetching === true,
  );
  const pulling = useStore(
    (s) => key !== undefined && s.branchActivity[key]?.pulling === true,
  );
  const pushing = useStore(
    (s) => key !== undefined && s.branchActivity[key]?.pushing === true,
  );
  const state = useStore((s) => s.state);
  const refreshBranches = useStore((s) => s.refreshBranches);
  const checkoutGitBranch = useStore((s) => s.checkoutGitBranch);
  const createBranch = useStore((s) => s.createBranch);
  const pullGitBranch = useStore((s) => s.pullGitBranch);
  const pushGitBranch = useStore((s) => s.pushGitBranch);
  const getPullRequestUrl = useStore((s) => s.getPullRequestUrl);
  const spawnGitResolution = useStore((s) => s.spawnGitResolution);
  const openSession = useStore((s) => s.openSession);
  const convertSessionToWorktree = useStore((s) => s.convertSessionToWorktree);
  const newWorktreeSession = useStore((s) => s.newWorktreeSession);
  // Another live session occupying this checkout: a checkout, `checkout -b`,
  // pull, push, or resolve affects its working tree / HEAD, so all earn a confirm.
  const occupant = useStore(useShallow((s) => checkoutOccupant(s, projectCwd, undefined, instanceId)));
  const busyTitle = occupant?.title ?? null;
  const busyPhrase = occupant !== null ? occupantActivityPhrase(occupant.reason) : "is mid-turn";
  const openFinishWorktree = useStore((s) => s.openFinishWorktree);
  const [openingWorktreeBranch, setOpeningWorktreeBranch] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"list" | "create" | "worktree" | "held">("list");
  const [heldBranch, setHeldBranch] = useState<string | null>(null);
  const [createStartPoint, setCreateStartPoint] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** True while the create-now conversion is in flight (button label). */
  const [cutting, setCutting] = useState(false);
  /** True while the publish row's first push is in flight (issue #414). */
  const [publishing, setPublishing] = useState(false);
  /** The checkout, pull, or push awaiting the busy-session confirm. */
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  /** Focus returns here when Escape closes the popover. */
  const triggerRef = useRef<HTMLButtonElement>(null);

  /** menuOpen mirror for the poll tick; a ref so opening the menu never
   * restarts the interval (it must stay out of the effect's dep array). */
  const menuOpenRef = useRef(false);

  const closeMenu = (): void => {
    setMenuOpen(false);
    menuOpenRef.current = false;
    setFilter("");
    setMode("list");
    setHeldBranch(null);
    setCreateStartPoint(null);
    setName("");
    setError(null);
    setConfirm(null);
  };

  /**
   * Escape peels one layer at a time: the new-branch form, held-branch actions,
   * and the busy-session confirm are sub-states of the open popover, not
   * separate surfaces.
   */
  const escapeStage = (): void => {
    if (mode === "create") {
      setMode("list");
      setCreateStartPoint(null);
      setName("");
      return;
    }
    if (mode === "worktree" || mode === "held") {
      setMode("list");
      setHeldBranch(null);
      return;
    }
    if (confirm !== null) {
      setConfirm(null);
      return;
    }
    closeMenu();
  };
  useEffect(() => {
    if (externalRequest == null) return;
    if (externalRequest.close) {
      closeMenu();
      return;
    }
    setMenuOpen(true);
    menuOpenRef.current = true;
    setMode("list");
    setHeldBranch(null);
    setCreateStartPoint(null);
    setConfirm(externalRequest.confirmPull ? { kind: "pull" } : null);
    setError(externalRequest.error ?? null);
  }, [externalRequest]);
  // First paint reads local refs only: mounting a project must not reach the
  // network. Upstream freshness arrives on open, focus, or visibility instead.
  useEffect(() => {
    if (projectCwd !== undefined && info === undefined) {
      void refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
    }
  }, [projectCwd, instanceId, info, refreshBranches]);

  // The composer drops the section the moment the session is prompted or
  // converted: a stale worktree sub-mode must not outlive the prop.
  useEffect(() => {
    if (workspace === undefined && mode === "worktree") setMode("list");
  }, [workspace, mode]);

  // Regaining the window is the cheapest honest moment to learn the branch
  // moved elsewhere. Both events fire on one alt-tab, so they share a debounce,
  // and a backgrounded window never spends a fetch. A window that stays
  // foregrounded never earns a focus event, so a poll covers it (issue #708).
  useEffect(() => {
    if (projectCwd === undefined) return;
    let timer: number | undefined;
    const scheduleNetworkRefresh = (): void => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshBranches(projectCwd, { fetchUpstream: true }, instanceId);
      }, NETWORK_REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener("focus", scheduleNetworkRefresh);
    document.addEventListener("visibilitychange", scheduleNetworkRefresh);
    // A foregrounded window never earns a focus event, so the badge would
    // otherwise age forever (issue #708): poll while visible. The core's
    // fetch-fresh window and failure cooldown bound the network cost; a tick
    // skips an open popover so it never disables the row mid-deliberation.
    const poll = window.setInterval(() => {
      if (document.visibilityState !== "visible" || menuOpenRef.current) return;
      void refreshBranches(projectCwd, { fetchUpstream: true }, instanceId);
    }, NETWORK_POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener("focus", scheduleNetworkRefresh);
      document.removeEventListener("visibilitychange", scheduleNetworkRefresh);
    };
  }, [projectCwd, instanceId, refreshBranches]);

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
    // The busy-checkout confirm renders inside the popover; keep the
    // alertdialog exemption so a pointerdown on it is never an outside click.
    exemptSelector: '[role="alertdialog"]',
  });

  if (projectCwd === undefined || info === undefined || info.repoRoot === null) return null;

  const { current, upstreamRef, hasUpstream, ahead, behind, defaultBranch, defaultRemote, mergeInProgress } =
    info;
  // hasUpstream is the resolution test, not the configuration test: a branch
  // whose remote ref was deleted keeps its configured upstreamRef and loses
  // hasUpstream, and that pair is exactly the "unavailable" state below.
  const resolvable = current !== null && upstreamRef !== null && hasUpstream;
  const diverged = resolvable && ahead > 0 && behind > 0;
  // A mid-merge checkout outranks divergence: it is the fact git itself
  // asserts, and its playbook covers divergence too. `diverged` already
  // requires a resolvable upstream, so the non-null gates below are what
  // TypeScript needs, not extra conditions.
  const resolveTrigger: GitResolutionTrigger | null = mergeInProgress
    ? { kind: "merge", branch: current, cwd: projectCwd }
    : diverged && current !== null && upstreamRef !== null
      ? { kind: "diverged", branch: current, upstream: upstreamRef, cwd: projectCwd }
      : null;
  /**
   * The chip's tooltip elaborates only what the chip itself shows: the behind
   * count. Ahead and diverged readings are popover business — the chip stays a
   * quiet indicator rather than a second place to read git state.
   */
  const behindReading =
    resolvable && behind > 0 && upstreamRef !== null
      ? `${commits(behind)} behind ${upstreamRef}`
      : null;

  /**
   * Every upstream state the pull action cannot serve, explained where the user
   * looked for the action. Behind-only is absent on purpose: the pull row is
   * its own explanation.
   */
  const note: { text: string; tone: "quiet" | "copper" } | null =
    mergeInProgress
      ? { text: "a merge is in progress in this checkout — conflicts are waiting", tone: "copper" }
      : current === null
      ? { text: "detached HEAD — check out a branch to track an upstream", tone: "quiet" }
      : upstreamRef === null
        ? { text: "no upstream configured for this branch", tone: "quiet" }
        : !hasUpstream
          ? { text: `upstream ${upstreamRef} is unavailable`, tone: "copper" }
          : diverged
            ? {
                text: `${ahead} ahead, ${behind} behind ${upstreamRef} — merge or rebase first`,
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
  // A pull never starts while a push moves the same refs (issue #416's
  // cross-gate, mirrored here in the UI as well as the store).
  const pullEnabled =
    resolvable && behind > 0 && ahead === 0 && !refreshing && !pulling && !pushing;

  // The push row follows the pull row's show-through-the-operation rule: the
  // post-push refresh zeroes `ahead` before `pushing` clears, and a row that
  // vanished mid-operation would read as a silent failure. A diverged branch
  // and an unresolvable upstream earn no row and no button — git would refuse
  // the push, or the ref it names is gone — and the copper note is the answer.
  const showPush = pushing || (resolvable && ahead > 0 && behind === 0);
  const pushEnabled =
    resolvable && ahead > 0 && behind === 0 && !refreshing && !pulling && !pushing;
  // Publishing is a branch's first push (`push -u`), so it needs no upstream
  // of its own — only a remote to publish into. It routes through the same
  // attemptPush, and the local latch plays the role `pushing` cannot: after
  // the bind-upstream refresh the row's own condition is already false.
  const showPublish =
    publishing || (current !== null && upstreamRef === null && defaultRemote !== null);
  const publishEnabled =
    current !== null &&
    upstreamRef === null &&
    defaultRemote !== null &&
    !refreshing &&
    !pulling &&
    !pushing;
  // A pull request proposes merging this branch's published commits into the
  // default branch, so both branches must exist, differ, and the head's ref
  // must be on the remote. The row is stateless: the URL is built on click.
  const showPullRequest =
    current !== null && defaultBranch !== null && current !== defaultBranch && hasUpstream;
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
  const enterWorktree = (seedBaseRef?: string): void => {
    if (!worktreeOffered || worktreeLocked) return;
    if (workspace !== undefined && workspace.mode === "worktree") {
      if (seedBaseRef !== undefined) {
        onWorkspaceChange?.((prev) =>
          prev.mode === "worktree"
            ? { ...prev, baseRef: seedBaseRef, baseBranch: null, baseTouched: true }
            : prev,
        );
      }
      setMode("worktree");
      return;
    }
    const prefix = worktreeBranchPrefix(projectCwd);
    onWorkspaceChange?.({
      mode: "worktree",
      branch: mintBranchName(prefix, seedBaseRef),
      baseRef: seedBaseRef ?? null,
      baseBranch: null,
      baseTouched: seedBaseRef !== undefined,
    });
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


  const toggleMenu = (): void => {
    if (menuOpen) {
      closeMenu();
      return;
    }
    onMenuOpen?.();
    setMenuOpen(true);
    menuOpenRef.current = true;
    // Fresh list *and* fresh upstream on every open — another tab (or the user
    // in a terminal) may have switched branches, and the remote may have moved.
    void refreshBranches(projectCwd, { fetchUpstream: true }, instanceId);
  };

  const attempt = async (branch: string, create: boolean): Promise<void> => {
    if (!create && branch === current) {
      closeMenu();
      return;
    }
    // Moving HEAD (plain checkout or `checkout -b`) causes another session's
    // next commit in this checkout to land on the wrong branch — both earn a confirm.
    const restating =
      confirm !== null &&
      confirm.kind === "checkout" &&
      confirm.branch === branch &&
      confirm.create === create;
    if (busyTitle !== null && !restating) {
      setConfirm({ kind: "checkout", branch, create });
      return;
    }
    setError(null);
    let err: string | null;
    if (create && createStartPoint !== null) {
      try {
        await createBranch(projectCwd, branch, createStartPoint, instanceId);
        err = await checkoutGitBranch(projectCwd, branch, undefined, instanceId);
      } catch (e) {
        err = displayMessage(e);
      }
    } else {
      err = await checkoutGitBranch(projectCwd, branch, create ? { create: true } : undefined, instanceId);
    }
    if (err !== null) {
      setError(err);
      setConfirm(null);
      return;
    }
    closeMenu();
  };
  const openBranchInWorktree = async (branch: string): Promise<void> => {
    if (openingWorktreeBranch) return;
    setOpeningWorktreeBranch(true);
    setError(null);
    try {
      if (worktreeOffered && tabId !== undefined && !worktreeLocked) {
        await convertSessionToWorktree(tabId, { checkout: { branch } });
      } else {
        await newWorktreeSession(projectCwd, { checkout: { branch } }, instanceId);
      }
      closeMenu();
    } catch (err) {
      setError(displayMessage(err));
      setConfirm(null);
    } finally {
      setOpeningWorktreeBranch(false);
    }
  };
  const attemptPull = async (): Promise<void> => {
    if (!pullEnabled) return;
    if (busyTitle !== null && confirm?.kind !== "pull") {
      setConfirm({ kind: "pull" });
      return;
    }
    setError(null);
    const err = await pullGitBranch(projectCwd, instanceId);
    if (err !== null) {
      setError(err);
      setConfirm(null);
      return;
    }
    closeMenu();
  };

  /**
   * The resolve row's click (issue #675): a fresh session in this checkout,
   * seeded with the resolution playbook. Click is consent, but a session
   * mid-turn on the same checkout earns the chip's busy confirm first —
   * the agent will edit and commit in that tree.
   */
  const attemptResolve = async (): Promise<void> => {
    if (resolveTrigger === null || refreshing || pulling || pushing) return;
    if (busyTitle !== null && confirm?.kind !== "resolve") {
      setConfirm({ kind: "resolve" });
      return;
    }
    void spawnGitResolution(projectCwd, resolveTrigger, instanceId);
    closeMenu();
  };

  /**
   * Pushes — or publishes, the same `git push` with no upstream yet (issue
   * #414) — the branch the row names. Like the pull it mirrors, sharing a
   * branch out from a mid-turn session confirms first: the snapshot goes as
   * it stands, work-in-progress and all.
   */
  const attemptPush = async (branch: string): Promise<void> => {
    // Either row can reach this: the push row needs an upstream and commits
    // ahead; the publish row needs the branch to have no upstream at all.
    if (!pushEnabled && !publishEnabled) return;
    if (busyTitle !== null && confirm?.kind !== "push") {
      setConfirm({ kind: "push", branch });
      return;
    }
    setError(null);
    try {
      const result = await pushGitBranch(projectCwd, branch, instanceId);
      // Git state resolves as an answer, never as an exception: a rejection
      // or a failure explains itself inline, the popover stays for a retry.
      if (result.kind === "rejected" || result.kind === "failed") {
        setError(result.detail);
        setConfirm(null);
        return;
      }
      closeMenu();
    } catch (err) {
      // Only a transport failure throws.
      setError(displayMessage(err));
      setConfirm(null);
    }
  };

  const attemptPublish = async (): Promise<void> => {
    if (!publishEnabled || publishing || current === null) return;
    setPublishing(true);
    await attemptPush(current);
    setPublishing(false);
  };

  /**
   * The pull-request row's click. The URL crosses to the browser through
   * window.open — main routes it via openExternalSafe; the renderer never
   * reaches shell.openExternal itself. A null URL means the remote has no
   * web face to compare on, which is a dead end explained, not a silence.
   */
  const openPullRequest = async (): Promise<void> => {
    if (current === null || defaultBranch === null) return;
    setError(null);
    try {
      const url = await getPullRequestUrl(projectCwd, defaultBranch, current, instanceId);
      if (url === null) {
        setError("cannot build a pull-request URL for this remote");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setError("cannot build a pull-request URL for this remote");
    }
  };

  const filtered = info.branches.filter((branch) =>
    branch.toLowerCase().includes(filter.toLowerCase()),
  );
  const displayedError = error;

  const worktrees = info.worktrees ?? {};
  const holderPathFor = (branch: string): string | null =>
    branch !== current && typeof worktrees[branch] === "string" ? worktrees[branch]! : null;
  const activeHeldPath = heldBranch === null ? null : holderPathFor(heldBranch);
  const activeHeldSession =
    activeHeldPath === null
      ? null
      : findWorktreeHolderSession(state, instanceId, activeHeldPath);

  return (
    <span
      ref={rootRef}
      className={cn(
        "relative flex min-w-0",
        placement === "flow" && "w-full flex-wrap",
        density === "touch" && "[&_button]:min-h-11",
      )}
    >
      <button
        ref={triggerRef}
        type="button"
        data-pill-segment={triggerVariant === "strip" ? "branch" : undefined}
        aria-expanded={menuOpen}
        title={
          workspace?.mode === "worktree"
            ? `worktree — the first prompt cuts ${workspace.branch} from ${baseBranchSegment(workspace.baseBranch, workspace.baseRef, current) ??
                  "current HEAD"}`
            : behindReading === null
              ? `branch — ${current ?? "detached HEAD"} (click to switch)`
              : `branch — ${current ?? "detached HEAD"} · ${behindReading} (click to switch)`
        }
        onClick={toggleMenu}
        className={cn(
          triggerVariant === "strip"
            ? cn(
                "tap-target inline-flex h-7 min-w-0 shrink items-center gap-1 border border-l-0 border-line px-2 text-sm text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink aria-expanded:bg-hover",
                joinRight ? "rounded-none" : "rounded-r-md",
              )
            : "tap-target inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-line px-1.5 font-mono text-xs leading-4 text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink",
        )}
      >
        {triggerVariant === "strip" ? (
          <>
            <span className="min-w-0 max-w-36 truncate">
              ⎇ {workspace?.mode === "worktree" ? workspace.branch : current ?? "detached"}
            </span>
            {workspace?.mode === "worktree" && (
              <span className="shrink-0 text-ink-dim">· worktree</span>
            )}
          </>
        ) : (
          <>
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
                  {behindReading}
                </span>
              </>
            )}
          </>
        )}
      </button>

      {menuOpen && (
        <div
          aria-busy={refreshing || pulling || pushing}
          className={cn(
            "animate-rise edge-lit z-20 flex flex-col rounded-md border border-line-strong bg-overlay p-1",
            placement === "flow" ? "mt-1 w-full basis-full" : "absolute bottom-full left-0 mb-1",
            placement === "float" && (mode === "worktree" ? "w-72" : "w-64"),
          )}
        >
          {confirm !== null ? (
            <>
              <div className="px-1.5 py-1 text-xs leading-snug text-copper">
                {confirm.kind === "pull"
                  ? `session “${busyTitle!}” ${busyPhrase} — pulling changes the project working tree`
                  : confirm.kind === "push"
                    ? `session “${busyTitle!}” ${busyPhrase} — the branch is shared as it stands`
                    : confirm.kind === "resolve"
                      ? `session “${busyTitle!}” ${busyPhrase} — the agent will change the same checkout`
                      : confirm.create
                        ? `session “${busyTitle!}” ${busyPhrase} — moving HEAD causes its next commit to land on ${confirm.branch}`
                        : `session “${busyTitle!}” ${busyPhrase} — the tree will change under it`}
              </div>
              <div className={cn("flex gap-1.5 px-1.5 pb-0.5", confirm.kind === "checkout" && !confirm.create && finishTabId === undefined && "flex-col")}>
                {confirm.kind === "pull" ? (
                  <Button
                    size="xs"
                    tone="copper"
                    disabled={!pullEnabled}
                    onClick={() => void attemptPull()}
                  >
                    {pulling ? "Pulling…" : "pull anyway"}
                  </Button>
                ) : confirm.kind === "push" ? (
                  <Button
                    size="xs"
                    tone="copper"
                    disabled={!pushEnabled && !publishEnabled}
                    onClick={() => void attemptPush(confirm.branch)}
                  >
                    {pushing ? "Pushing…" : "push anyway"}
                  </Button>
                ) : confirm.kind === "resolve" ? (
                  <Button
                    size="xs"
                    tone="copper"
                    onClick={() => void attemptResolve()}
                  >
                    resolve anyway
                  </Button>
                ) : !confirm.create && finishTabId === undefined ? (
                  <>
                    <Button
                      size="xs"
                      disabled={openingWorktreeBranch || (worktreeOffered && worktreeLocked)}
                      onClick={() => void openBranchInWorktree(confirm.branch)}
                    >
                      {openingWorktreeBranch ? "Opening worktree…" : `Open ${confirm.branch} in worktree`}
                    </Button>
                    <div className="flex gap-1.5">
                      <Button
                        size="xs"
                        tone="copper"
                        disabled={openingWorktreeBranch}
                        onClick={() => void attempt(confirm.branch, false)}
                      >
                        Switch shared checkout anyway
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
                        cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button
                    size="xs"
                    tone="copper"
                    onClick={() => void attempt(confirm.branch, confirm.create)}
                  >
                    {confirm.create ? "create & switch anyway" : "switch anyway"}
                  </Button>
                )}
                {!(confirm.kind === "checkout" && !confirm.create && finishTabId === undefined) && (
                  <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
                    cancel
                  </Button>
                )}
              </div>
            </>
          ) : mode === "held" && heldBranch !== null ? (
            <>
              <div className="px-1.5 py-1 text-xs leading-snug text-ink-mid">
                <span className="font-mono text-ink">{heldBranch}</span> is checked out in{" "}
                {activeHeldSession !== null ? (
                  <span>“{activeHeldSession.title}”</span>
                ) : (
                  <span className="font-mono" title={activeHeldPath ?? undefined}>
                    {activeHeldPath ?? "another worktree"}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1 px-1 pb-0.5">
                {activeHeldSession !== null && (
                  <Button
                    size="xs"
                    onClick={() => {
                      const targetTabId = activeHeldSession.tabId;
                      closeMenu();
                      void openSession(targetTabId);
                    }}
                  >
                    Jump to session
                  </Button>
                )}
                <Button
                  size="xs"
                  variant={activeHeldSession !== null ? "ghost" : "solid"}
                  disabled={worktreeOffered && worktreeLocked}
                  onClick={() => {
                    const b = heldBranch;
                    setHeldBranch(null);
                    setError(null);
                    if (worktreeOffered) {
                      enterWorktree(b);
                    } else {
                      setCreateStartPoint(b);
                      setMode("create");
                    }
                  }}
                >
                  New branch from here
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setMode("list");
                    setHeldBranch(null);
                  }}
                >
                  back
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
                className="mx-1 mb-1 rounded border border-line bg-void px-1.5 py-1 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
              />
              <span className="px-1.5 pb-1 text-xs text-ink-faint">
                {createStartPoint !== null
                  ? `creates from ${createStartPoint} and switches to it`
                  : "creates and switches to the branch"}
              </span>
              <div className="flex gap-1.5 px-1.5 pb-0.5">
                <Button
                  size="xs"
                  disabled={name.trim() === ""}
                  onClick={() => void attempt(name.trim(), true)}
                >
                  {"create & switch"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setMode("list");
                    setCreateStartPoint(null);
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
                instanceId={instanceId}
                branch={workspace.branch}
                onBranchChange={(branch) =>
                  onWorkspaceChange?.((prev) =>
                    prev.mode === "worktree" ? { ...prev, branch } : prev,
                  )
                }
                baseRef={workspace.baseRef}
                onBaseRefChange={(baseRef) =>
                  // The functional form merges against the latest selection;
                  // one event can emit a ref change and a branch change.
                  // WorktreeBranchFields owns the recomposition (issue #438).
                  onWorkspaceChange?.((prev) =>
                    prev.mode === "worktree" ? { ...prev, baseRef } : prev,
                  )
                }
                baseBranch={workspace.baseBranch}
                onBaseBranchChange={(baseBranch) =>
                  onWorkspaceChange?.((prev) =>
                    prev.mode === "worktree" ? { ...prev, baseBranch } : prev,
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
              <span className="px-1.5 pb-1 text-xs text-ink-faint">
                create it now, or the first prompt cuts it
              </span>
              <div className="flex gap-1.5 px-1.5 pb-0.5">
                {onCreateWorktree !== undefined && (
                  <Button
                    size="xs"
                    disabled={cutting || worktreeLocked || info === undefined || workspace.branch.trim() === "" || (workspace.baseBranch !== null && workspace.baseBranch.trim() === "")}
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
              {finishTabId !== undefined && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    openFinishWorktree(finishTabId);
                  }}
                  className="rounded px-1.5 py-0.5 text-left font-mono text-xs text-ink-mid hover:bg-hover hover:text-ink"
                >
                  finish worktree…
                </button>
              )}
              {showPull && (
                <button
                  type="button"
                  disabled={!pullEnabled}
                  onClick={() => void attemptPull()}
                  className="rounded px-1.5 py-0.5 text-left font-mono text-xs text-ink hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim"
                >
                  {pulling ? "Pulling…" : `pull ${commits(behind)}`}
                </button>
              )}
              {/* The `upstreamRef !== null` and `current`/`defaultRemote`
                  conjuncts restate what showPush/showPublish's own branches
                  prove (or the in-flight label, which names neither); they
                  exist so TypeScript can see what the user can already. */}
              {showPush && upstreamRef !== null && (
                <button
                  type="button"
                  disabled={!pushEnabled}
                  onClick={() => {
                    if (current !== null) void attemptPush(current);
                  }}
                  className="rounded px-1.5 py-0.5 text-left font-mono text-xs text-ink hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim"
                >
                  {pushing
                    ? "Pushing…"
                    : `push ${commits(ahead)} to ${upstreamRef}`}
                </button>
              )}
              {showPublish && current !== null && defaultRemote !== null && (
                <button
                  type="button"
                  disabled={!publishEnabled}
                  onClick={() => void attemptPublish()}
                  className="rounded px-1.5 py-0.5 text-left font-mono text-xs text-ink hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim"
                >
                  {`publish ${current} to ${defaultRemote}`}
                </button>
              )}
              {showPullRequest && (
                <button
                  type="button"
                  onClick={() => void openPullRequest()}
                  className="rounded px-1.5 py-0.5 text-left font-mono text-xs text-ink hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim"
                >
                  pull request…
                </button>
              )}
              {resolveTrigger !== null && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={refreshing || pulling || pushing}
                  onClick={() => void attemptResolve()}
                  className="rounded px-1.5 py-0.5 text-left font-mono text-xs text-ink hover:bg-hover disabled:pointer-events-none disabled:text-ink-dim"
                >
                  {resolveTrigger.kind === "diverged"
                    ? `integrate with ${resolveTrigger.upstream}…`
                    : "resolve merge conflicts…"}
                </button>
              )}
              {note !== null && (
                <div
                  className={cn(
                    "px-1.5 py-1 text-xs leading-snug",
                    note.tone === "copper" ? "text-copper" : "text-ink-faint",
                  )}
                >
                  {note.text}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setCreateStartPoint(null);
                  setMode("create");
                  setError(null);
                }}
                className="rounded px-1.5 py-0.5 text-left font-mono text-xs text-ink-mid hover:bg-hover"
              >
                new branch…
              </button>
              {workspace?.mode === "worktree" && (
                <button
                  type="button"
                  disabled={worktreeLocked}
                  onClick={pickCheckout}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover",
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
                  onClick={() => enterWorktree()}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover",
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
                    const first = filtered[0]!;
                    if (holderPathFor(first) !== null) {
                      setHeldBranch(first);
                      setMode("held");
                      setError(null);
                    } else {
                      void attempt(first, false);
                    }
                  }
                }}
                className="mx-1 mb-1 rounded border border-line bg-void px-1.5 py-1 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
              />
              <div className="flex max-h-64 flex-col overflow-y-auto">
                {filtered.map((branch) => {
                  const holderPath = holderPathFor(branch);
                  const holderSession =
                    holderPath === null
                      ? null
                      : findWorktreeHolderSession(state, instanceId, holderPath);
                  const holderBase =
                    holderPath === null
                      ? null
                      : holderPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? holderPath;
                  return (
                    <button
                      key={branch}
                      type="button"
                      disabled={branch === current}
                      title={holderPath ?? undefined}
                      onClick={() => {
                        if (holderPath !== null) {
                          setHeldBranch(branch);
                          setMode("held");
                          setError(null);
                          return;
                        }
                        void attempt(branch, false);
                      }}
                      className={cn(
                        "flex min-w-0 items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover",
                        "disabled:pointer-events-none",
                        branch === current ? "text-iris" : "text-ink-mid",
                      )}
                    >
                      <span className="min-w-0 truncate">{branch}</span>
                      {holderPath !== null && (
                        <span className="max-w-28 shrink-0 truncate text-xs text-ink-faint">
                          {holderSession !== null
                            ? `in ${holderSession.title}`
                            : `in …/${holderBase}`}
                        </span>
                      )}
                    </button>
                  );
                })}
                {filtered.length === 0 && (
                  <span className="px-1.5 py-0.5 font-mono text-xs text-ink-faint">
                    no matches
                  </span>
                )}
              </div>
            </>
          )}
          {/* A background fetch that failed is not worth interrupting anyone
              for — it surfaces here, quietly, only once the popover is open. */}
          {fetching && (
            <div className="px-1.5 py-1 text-xs text-ink-faint">refreshing upstream…</div>
          )}
          {info.upstreamRefreshError !== null && !fetching && (
            <div className="break-words px-1.5 py-1 text-xs leading-snug text-rose">
              {info.upstreamRefreshError}
            </div>
          )}
          {displayedError !== null && (
            <div className="break-words px-1.5 py-1 text-xs text-rose">{displayedError}</div>
          )}
        </div>
      )}
    </span>
  );
}
