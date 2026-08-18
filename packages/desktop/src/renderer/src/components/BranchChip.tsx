import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { findRecord, sessionCwd, useStore } from "../store";
import { Button } from "./ui";
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
 * "worktree" marker. Neutral chrome only — signal mint is reserved for agent
 * liveness (ADR-0004), and neither branch identity nor upstream drift is
 * liveness, so divergence escalates to copper and failures to rose.
 *
 * Upstream reads are transport-only: the store owns every git call, coalesces
 * concurrent refreshes, and keeps the last good snapshot when one fails, so
 * this component never blanks the branch it already showed.
 */

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Focus and visibility both fire on a single alt-tab back into the window;
 * one short debounce collapses that pair into one network refresh. Staleness
 * beyond this is absorbed by the store's own freshness window.
 */
const NETWORK_REFRESH_DEBOUNCE_MS = 250;

/** The working-tree change awaiting the busy-session confirm. */
type Pending = { kind: "checkout"; branch: string } | { kind: "pull" };

const commits = (count: number): string => `${count} commit${count === 1 ? "" : "s"}`;

export function BranchChip({
  projectCwd,
  workspace,
  onWorkspaceChange,
  workspaceDisabled = false,
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
  // Matched on the effective cwd, so a running worktree session guards its
  // own checkout — the tab's projectCwd would see every worktree of a
  // project as the same place.
  const busyTitle = useStore((s) => {
    const tab = s.tabs.find(
      (t) =>
        sessionCwd(findRecord(s.state, t.tabId)) === projectCwd &&
        s.rpc[t.tabId]?.status === "running",
    );
    return tab ? (findRecord(s.state, tab.tabId)?.title ?? "a session") : null;
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"list" | "create" | "worktree">("list");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The change awaiting the busy-session confirm; null when not confirming. */
  const [confirm, setConfirm] = useState<Pending | null>(null);

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
  useEffect(() => {
    if (!menuOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      closeMenu();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const closing = mode === "list" && confirm === null;
      escapeStage();
      if (closing) triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [menuOpen, mode, confirm]);

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

  const toggleMenu = (): void => {
    if (menuOpen) {
      closeMenu();
      return;
    }
    setMenuOpen(true);
    // Fresh list *and* fresh upstream on every open — another tab (or the user
    // in a terminal) may have switched branches, and the remote may have moved.
    void refreshBranches(projectCwd, { fetchUpstream: true });
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

  const filtered = info.branches.filter((branch) =>
    branch.toLowerCase().includes(filter.toLowerCase()),
  );

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
          <circle cx="5" cy="4" r="1.6" {...S} />
          <circle cx="5" cy="12" r="1.6" {...S} />
          <circle cx="11" cy="6" r="1.6" {...S} />
          <path d="M5 5.6v4.8M11 7.6c0 2.2-2.4 2.4-3.7 3" {...S} />
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
                the first prompt cuts this branch in a fresh worktree
              </span>
              <div className="flex gap-1.5 px-1.5 pb-0.5">
                <Button size="xs" variant="ghost" onClick={() => setMode("list")}>
                  back
                </Button>
              </div>
            </>
          ) : (
            <>
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
    </span>
  );
}
