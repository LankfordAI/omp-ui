import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MergeBackStatus, SessionWorktree } from "@omp-ui/core/types";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { runningSessionTitleOnCheckout, useStore } from "../store";
import { Button, Chip, ConfirmDialog, CopyButton, Panel } from "./ui";

/**
 * The Session HUD's worktree chip as an actionable popover (issue #260): the
 * chip itself is unchanged — mono `⎇ branch`, checkout path in the tooltip —
 * but clicking it opens copy rows for the branch and the checkout path, a
 * quiet "cut from <base>" line, a merge-back section for the recorded base
 * (issue #272), and open targets (VS Code when available, Files always) that
 * hand the checkout path to the existing openProject channel. Neutral chrome
 * throughout — the signal accent stays reserved for liveness (ADR-0004), and
 * the merge section escalates to copper where the user must act, quiet when
 * the work is already done, and failures to the rose error slot. Positioning
 * and dismissal follow the sidebar's terminal-menu convention; Escape
 * restores focus to the trigger, matching BranchChip.
 */

/**
 * A 40-hex commit base reads as its 8-char short form; a ref name (the user's
 * own pick) reads verbatim. Shared with the diffs pane's "since" chip.
 */
export function shortBase(base: string): string {
  return /^[0-9a-f]{40}$/.test(base) ? base.slice(0, 8) : base;
}

const rowText =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";
const copperNote = "px-2.5 pb-1.5 text-[10px] leading-relaxed text-copper";
const quietNote = "px-2.5 pb-1.5 text-[10px] leading-relaxed text-ink-faint";

const commits = (count: number): string => `${count} commit${count === 1 ? "" : "s"}`;

export function WorktreeChip({
  worktree,
  tabId,
  projectCwd,
  className,
}: {
  worktree: SessionWorktree;
  tabId: string;
  projectCwd: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  /** null = never asked; asked once per mount, like the sidebar's discovery. */
  const [vsCodeAvailable, setVsCodeAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** null = not fetched yet, or the fetch rejected (see the error slot). */
  const [mergeStatus, setMergeStatus] = useState<MergeBackStatus | null>(null);
  const [merging, setMerging] = useState(false);
  /** The copper confirm modal, portaled outside the popover. */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** The inline busy-session sub-state of the open popover. */
  const [busyConfirm, setBusyConfirm] = useState(false);
  /** Quiet success line after a completed merge. */
  const [mergedNote, setMergedNote] = useState<string | null>(null);
  /** Files from a fresh conflicted merge; null when none. */
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);

  const readMergeBackStatus = useStore((s) => s.readMergeBackStatus);
  const mergeWorktreeBranch = useStore((s) => s.mergeWorktreeBranch);
  const appendNotice = useStore((s) => s.appendNotice);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const consoleIsOpen = useStore((s) => s.consoleOpen[tabId] === true);

  // A session mid-turn in the project checkout: the merge moves the
  // destination branch out from under it. The self tab is excluded.
  const busyTitle = useStore((s) => runningSessionTitleOnCheckout(s, projectCwd, tabId));

  /** Wraps the trigger *and* the popover, so one containment test covers both. */
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = (): void => {
    setOpen(false);
    setError(null);
    setMergeStatus(null);
    setMerging(false);
    setConfirmOpen(false);
    setBusyConfirm(false);
    setMergedNote(null);
    setConflictFiles(null);
  };

  /**
   * Feasibility read; a rejection keeps the status null and lands in the
   * error slot. Re-fetched after every merge attempt so the next render
   * shows the settled git state (already-merged, merge-in-progress, …).
   */
  const fetchStatus = (): void => {
    if (worktree.base === null) return;
    readMergeBackStatus(projectCwd, worktree.branch, worktree.base)
      .then(setMergeStatus)
      .catch((err: unknown) => {
        setMergeStatus(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const toggle = (): void => {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    setPos(rect ? { x: rect.left, y: rect.bottom + 4 } : null);
    setOpen(true);
    if (vsCodeAvailable === null) {
      backend
        .getProjectOpenAvailability()
        .then((a) => setVsCodeAvailable(a.vsCode))
        .catch(() => setVsCodeAvailable(false));
    }
    fetchStatus();
  };

  // Click-outside / Escape dismissal, matching BranchChip. The trigger is
  // inside rootRef, so a click on it is not an outside click — its own
  // onClick toggles, and the popover closes exactly once. A pointerdown on
  // the confirm modal (portaled outside rootRef) is not an outside click
  // either: it is this popover's own decision surface.
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[role="alertdialog"]') !== null) return;
      close();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  const openIn = (target: "vscode" | "files"): void => {
    setError(null);
    backend.openProject(worktree.path, target).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  /**
   * The console drawer's shell starts in the worktree checkout — the
   * guidance text always carries the project path for the `cd` — so the
   * button only opens an already-closed drawer, never closes one.
   */
  const openConsole = (): void => {
    if (!consoleIsOpen) toggleConsole(tabId);
  };

  const onMergeClick = (): void => {
    if (busyTitle !== null && !busyConfirm) {
      setBusyConfirm(true);
      return;
    }
    setConfirmOpen(true);
  };

  const runMerge = async (): Promise<void> => {
    const destination = mergeStatus?.destination;
    if (destination === null || destination === undefined) return;
    setMerging(true);
    try {
      const result = await mergeWorktreeBranch(projectCwd, worktree.branch, destination);
      setConfirmOpen(false);
      setBusyConfirm(false);
      if (result.kind === "ff") {
        setMergedNote(`merged into ${destination} (fast-forward, ${commits(result.commits)})`);
        appendNotice(
          tabId,
          `merged ${worktree.branch} into ${destination} — fast-forward, ${commits(result.commits)}`,
          "info",
        );
      } else if (result.kind === "merged") {
        setMergedNote(`merged into ${destination} (${commits(result.commits)}, merge commit)`);
        appendNotice(
          tabId,
          `merged ${worktree.branch} into ${destination} — ${commits(result.commits)}, merge commit`,
          "info",
        );
      } else if (result.kind === "conflicts") {
        setConflictFiles(result.files);
        const more = result.files.length > 5 ? `, and ${result.files.length - 5} more` : "";
        appendNotice(
          tabId,
          `merge of ${worktree.branch} into ${destination} stopped — ${result.files.length} file(s) conflict: ${result.files
            .slice(0, 5)
            .join(", ")}${more}. Resolve in ${projectCwd} (git merge --continue) or abort (git merge --abort).`,
          "warn",
        );
      }
      // already-merged: no note, no notice — the re-fetched status renders
      // the guidance line.
    } catch (err: unknown) {
      setConfirmOpen(false);
      setBusyConfirm(false);
      setMergedNote(null);
      setConflictFiles(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
      fetchStatus();
    }
  };

  /**
   * The merge-back block (issue #272), first match wins: a disabled
   * pending/merging row, an explanatory note with an escape hatch, the
   * inline busy confirm, or the merge action itself. Copper notes are
   * "you must act"; quiet ones, "already done".
   */
  const mergeSection = (): ReactNode => {
    if (worktree.base === null) return null;
    if (mergeStatus === null) {
      // Fetch in flight (or rejected — the error slot says so): the row
      // survives, disabled, naming the base as the destination to merge
      // into — and "merging…" while the operation is in flight.
      return (
        <button type="button" role="menuitem" className={rowText} disabled>
          {merging ? "merging…" : `merge into ${shortBase(worktree.base)}`}
        </button>
      );
    }
    if (merging) {
      // The row survives the merge itself: a row that vanished mid-operation
      // would read as a silent failure (the BranchChip pull-row pattern).
      return (
        <button type="button" role="menuitem" className={rowText} disabled>
          merging…
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
          <div className="flex gap-1.5 px-2.5 pb-1.5">
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
          <div className="max-h-24 overflow-y-auto px-2.5 pb-1 font-mono text-[10px] leading-relaxed text-ink-mid">
            {conflictFiles.map((file) => (
              <span key={file} className="block truncate" title={file}>
                {file}
              </span>
            ))}
          </div>
          <p className={quietNote}>
            resolve in {projectCwd}, then git merge --continue — or git merge --abort
          </p>
          <div className="flex gap-1.5 px-2.5 pb-1.5">
            <Button size="xs" variant="ghost" onClick={openConsole}>
              open console
            </Button>
          </div>
        </>
      );
    }
    if (mergedNote !== null) {
      return <p className={quietNote}>{mergedNote}</p>;
    }
    if (!mergeStatus.branchExists) {
      return (
        <p className={copperNote}>branch {worktree.branch} no longer exists — nothing to merge</p>
      );
    }
    if (mergeStatus.destination === null) {
      const short = shortBase(worktree.base);
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
        <p className={copperNote}>check out {mergeStatus.destination} in the project to merge back</p>
      );
    }
    if (mergeStatus.alreadyMerged) {
      return (
        <p className={quietNote}>
          already in {mergeStatus.destination} — delete the session to reclaim the checkout (the
          branch survives)
        </p>
      );
    }
    if (busyConfirm) {
      return (
        <>
          <div className="px-2.5 py-1 text-[11px] leading-snug text-copper">
            session “{busyTitle}” is mid-turn in the project — merging moves{" "}
            {mergeStatus.destination} under it
          </div>
          <div className="flex gap-1.5 px-2.5 pb-1.5">
            <Button size="xs" tone="copper" onClick={() => void runMerge()}>
              merge anyway
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setBusyConfirm(false)}>
              cancel
            </Button>
          </div>
        </>
      );
    }
    return (
      <button type="button" role="menuitem" className={rowText} onClick={onMergeClick}>
        merge into {mergeStatus.destination}
        {mergeStatus.ahead > 0 && (
          <span className="text-ink-faint"> · {commits(mergeStatus.ahead)}</span>
        )}
      </button>
    );
  };

  return (
    <span ref={rootRef} className={cn("inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={worktree.path}
        onClick={toggle}
        className="rounded-full focus-visible:outline focus-visible:outline-1 focus-visible:outline-line"
      >
        <Chip mono>⎇ {worktree.branch}</Chip>
      </button>
      {open &&
        pos !== null &&
        createPortal(
          <div role="menu" className="fixed z-50" style={{ left: pos.x, top: pos.y }}>
            <Panel
              className={cn(
                "edge-lit animate-rise w-64 p-1",
                pos.x > window.innerWidth / 2 && "-translate-x-full",
              )}
            >
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="min-w-0 truncate font-mono text-xs text-ink" title={worktree.branch}>
                  {worktree.branch}
                </span>
                <CopyButton text={worktree.branch} label="copy" />
              </div>
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span
                  className="min-w-0 truncate font-mono text-[10px] text-ink-faint"
                  title={worktree.path}
                >
                  {worktree.path}
                </span>
                <CopyButton text={worktree.path} label="copy" />
              </div>
              {worktree.base !== null && (
                <p className="px-2.5 pb-1.5 text-[10px] text-ink-faint" title={worktree.base}>
                  cut from {shortBase(worktree.base)}
                </p>
              )}
              <div className="my-1 border-t border-line-soft" />
              {mergeSection()}
              {vsCodeAvailable === true && (
                <button type="button" role="menuitem" className={rowText} onClick={() => openIn("vscode")}>
                  Open in VS Code
                </button>
              )}
              <button type="button" role="menuitem" className={rowText} onClick={() => openIn("files")}>
                Open in Files
              </button>
              {error !== null && (
                <p role="alert" className="px-2.5 py-1.5 text-[10px] leading-relaxed text-rose">
                  {error}
                </p>
              )}
            </Panel>
          </div>,
          document.body,
        )}
      {confirmOpen && mergeStatus !== null && mergeStatus.destination !== null && (
        <ConfirmDialog
          kicker="git operation"
          tone="copper"
          width="w-[28rem]"
          title={`Merge ${worktree.branch} into ${mergeStatus.destination}?`}
          onClose={() => setConfirmOpen(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                cancel
              </Button>
              <Button
                variant="solid"
                tone="copper"
                disabled={merging}
                onClick={() => void runMerge()}
              >
                {merging ? "merging…" : `merge into ${mergeStatus.destination}`}
              </Button>
            </>
          }
        >
          <p>
            Fast-forwards when history allows, otherwise creates a merge commit in the project
            checkout. Merges the {mergeStatus.ahead} committed change(s) on {worktree.branch};
            uncommitted changes in the worktree are not included. A conflict stops the merge and
            leaves the project checkout with files to resolve.
          </p>
        </ConfirmDialog>
      )}
    </span>
  );
}
