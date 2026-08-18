import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useStore } from "../store";
import { mintBranchName, WorktreeBranchFields } from "./WorktreeBranchFields";

/**
 * Where an unprompted session's first prompt will run (issue #225): the
 * project checkout as-is, or a fresh worktree cut on the first send.
 */
export type WorkspaceSelection =
  | { mode: "checkout" }
  | { mode: "worktree"; branch: string; baseRef: string | null };

/**
 * The composer's workspace selector (issue #225): a chip offering the current
 * checkout or a fresh worktree for an unprompted session's first prompt.
 * Picking the worktree mints a branch once and expands a sub-row with the
 * shared branch/base fields; the conversion itself happens on send, and its
 * failure renders inline in the sub-row with the draft intact. Neutral chrome
 * only — the selection is session setup, not liveness (ADR-0004).
 */
export function WorkspaceControl({
  projectCwd,
  disabled = false,
  value,
  onChange,
  error,
  pending,
}: {
  projectCwd: string | undefined;
  disabled?: boolean;
  value: WorkspaceSelection;
  onChange: (value: WorkspaceSelection) => void;
  /** The last conversion failure, rendered inline in the sub-row. */
  error: string | null;
  /** True while the first send is converting the session. */
  pending: boolean;
}) {
  const info = useStore((s) => (projectCwd === undefined ? undefined : s.branches[projectCwd]));
  const refreshBranches = useStore((s) => s.refreshBranches);

  const [menuOpen, setMenuOpen] = useState(false);

  /** Wraps the trigger *and* the popover, so one containment test covers both. */
  const rootRef = useRef<HTMLSpanElement>(null);
  /** Focus returns here when Escape closes the popover. */
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeMenu = (): void => {
    setMenuOpen(false);
  };

  // First paint reads local refs only: mounting a project must not reach the
  // network. The listing decides whether "New worktree" is even offered.
  useEffect(() => {
    if (projectCwd !== undefined && info === undefined) {
      void refreshBranches(projectCwd, { fetchUpstream: false });
    }
  }, [projectCwd, info, refreshBranches]);

  // Click-outside / Escape dismissal, matching BranchChip. The trigger is
  // *inside* rootRef, so a click on it is not an outside click — its own
  // onClick toggles, and the popover closes exactly once.
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
      closeMenu();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [menuOpen]);

  if (projectCwd === undefined) return null;

  // repoRoot null (not undefined — undefined means the listing hasn't loaded
  // yet) means the project isn't a git repository at all.
  const notGit = info?.repoRoot === null;

  const toggleMenu = (): void => {
    if (menuOpen) closeMenu();
    else setMenuOpen(true);
  };

  const pickCheckout = (): void => {
    onChange({ mode: "checkout" });
    closeMenu();
  };

  const pickWorktree = (): void => {
    if (notGit) return;
    // Already the selection: keep the minted branch and any edits — picking
    // the active row must not wipe them.
    if (value.mode === "worktree") {
      closeMenu();
      return;
    }
    // Minted once per pick; the name stays editable in the sub-row.
    onChange({ mode: "worktree", branch: mintBranchName(), baseRef: null });
    closeMenu();
  };

  return (
    <span ref={rootRef} className="relative flex min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={menuOpen}
        disabled={disabled}
        title="where this session's first prompt runs"
        onClick={toggleMenu}
        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-line px-1.5 font-mono text-[10px] leading-4 text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:text-ink-dim"
      >
        {value.mode === "worktree" ? "⎇ worktree" : "checkout"}
      </button>

      {menuOpen && (
        <div className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-60 flex-col rounded-md border border-line-strong bg-overlay p-1">
          <button
            type="button"
            onClick={pickCheckout}
            className={cn(
              "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
              value.mode === "checkout" ? "text-iris" : "text-ink-mid",
            )}
          >
            Current checkout
          </button>
          <button
            type="button"
            disabled={notGit}
            title={
              notGit
                ? "This project isn't inside a git repo, so there's nothing to worktree."
                : undefined
            }
            onClick={pickWorktree}
            className={cn(
              "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
              // No pointer-events-none here: the disabled state carries the
              // non-git hint as its tooltip, which hover must still reach.
              "disabled:text-ink-dim disabled:hover:bg-transparent",
              value.mode === "worktree" ? "text-iris" : "text-ink-mid",
            )}
          >
            New worktree
          </button>
        </div>
      )}

      {/* The sub-row is the persistent half of the selection: it stays
          MOUNTED even while the popover overlaps it (z-20 over z-10), so the
          fields' baseTouched latch and any edits survive a popover round-trip
          right up to the first send. */}
      {value.mode === "worktree" && (
        <div className="animate-rise edge-lit absolute bottom-full left-0 z-10 mb-1 flex w-72 flex-col gap-3 rounded-md border border-line-strong bg-overlay p-2">
          <WorktreeBranchFields
            projectCwd={projectCwd}
            branch={value.branch}
            onBranchChange={(branch) => onChange({ ...value, branch })}
            baseRef={value.baseRef}
            onBaseRefChange={(baseRef) => onChange({ ...value, baseRef })}
            idPrefix="composer-worktree"
          />
          {pending && <div className="text-[10px] text-ink-faint">cutting the worktree…</div>}
          {error !== null && (
            <p className="break-words text-[11px] leading-snug text-rose">{error}</p>
          )}
        </div>
      )}
    </span>
  );
}
