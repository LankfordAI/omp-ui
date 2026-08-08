import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { findRecord, useStore } from "../store";
import { Button } from "./ui";

/**
 * The composer's git-branch indicator and switcher (issue #35): a neutral chip
 * showing the project's current branch, opening a filter-as-you-type menu of
 * local branches with a "new branch…" action. Hidden entirely on non-git
 * projects. Neutral chrome only — signal mint is reserved for agent liveness
 * (ADR-0004), and branch identity is not liveness.
 */

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function BranchChip({ projectCwd }: { projectCwd?: string }) {
  const info = useStore((s) => (projectCwd ? s.branches[projectCwd] : undefined));
  const refreshBranches = useStore((s) => s.refreshBranches);
  const checkoutGitBranch = useStore((s) => s.checkoutGitBranch);
  // A session mid-turn on this project: a plain checkout would move the
  // working tree out from under it, so it earns a confirm first.
  const busyTitle = useStore((s) => {
    const tab = s.tabs.find(
      (t) => t.projectCwd === projectCwd && s.rpc[t.tabId]?.status === "running",
    );
    return tab ? (findRecord(s.state, tab.tabId)?.title ?? "a session") : null;
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"list" | "create">("list");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Branch name awaiting the busy-session confirm; null when not confirming. */
  const [confirm, setConfirm] = useState<string | null>(null);

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
    if (confirm !== null) {
      setConfirm(null);
      return;
    }
    closeMenu();
  };

  useEffect(() => {
    if (projectCwd !== undefined && info === undefined) void refreshBranches(projectCwd);
  }, [projectCwd, info, refreshBranches]);

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

  const toggleMenu = (): void => {
    if (menuOpen) {
      closeMenu();
      return;
    }
    setMenuOpen(true);
    // Fresh list on every open — another tab (or the user in a terminal) may
    // have switched or created branches since the last read.
    void refreshBranches(projectCwd);
  };

  const attempt = async (branch: string, create: boolean): Promise<void> => {
    if (!create && branch === info.current) {
      closeMenu();
      return;
    }
    // The busy confirm guards plain checkout only: `checkout -b` does not move
    // the working tree, so the create flow skips it.
    if (!create && busyTitle !== null && confirm !== branch) {
      setConfirm(branch);
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

  const filtered = info.branches.filter((branch) =>
    branch.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <span ref={rootRef} className="relative flex">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={menuOpen}
        title={`branch — ${info.current ?? "detached HEAD"} (click to switch)`}
        onClick={toggleMenu}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line px-1.5 font-mono text-[10px] leading-4 text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
          <circle cx="5" cy="4" r="1.6" {...S} />
          <circle cx="5" cy="12" r="1.6" {...S} />
          <circle cx="11" cy="6" r="1.6" {...S} />
          <path d="M5 5.6v4.8M11 7.6c0 2.2-2.4 2.4-3.7 3" {...S} />
        </svg>
        <span className="max-w-44 truncate">{info.current ?? "detached"}</span>
      </button>

      {menuOpen && (
        <div
          className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-60 flex-col rounded-md border border-line-strong bg-overlay p-1"
        >
          {confirm !== null ? (
            <>
              <div className="px-1.5 py-1 text-[11px] leading-snug text-copper">
                session “{busyTitle}” is mid-turn — the tree will change under it
              </div>
              <div className="flex gap-1.5 px-1.5 pb-0.5">
                <Button size="xs" tone="copper" onClick={() => void attempt(confirm, false)}>
                  switch anyway
                </Button>
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
          ) : (
            <>
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
                    disabled={branch === info.current}
                    onClick={() => void attempt(branch, false)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                      "disabled:pointer-events-none",
                      branch === info.current ? "text-iris" : "text-ink-mid",
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
          {error !== null && (
            <div className="break-words px-1.5 py-1 text-[11px] text-rose">{error}</div>
          )}
        </div>
      )}
    </span>
  );
}
