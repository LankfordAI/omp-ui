import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionWorktree } from "@omp-ui/core/types";
import { backend } from "../backend";
import { useDismissal } from "../lib/use-dismissal";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { shortBase } from "../lib/format";
import { Chip, CopyButton, Panel } from "./ui";
import { useStore } from "../store";

/**
 * The Session HUD's worktree chip as an actionable popover (issue #260): the
 * chip itself is unchanged — mono `⎇ branch`, checkout path in the tooltip —
 * but clicking it opens copy rows for the branch and the checkout path, a
 * quiet "cut from <base>" line, one row that opens the Finish worktree
 * dialog (issues #385–#389 — the merge-and-return decisions moved there,
 * out of this popover), plus host-local open targets when enabled (VS Code
 * when available, Files always) that hand the checkout path to openProject.
 * Neutral chrome throughout — the signal accent stays reserved for liveness
 * (ADR-0004). No status fetch on open: feasibility is the dialog's business.
 * Positioning and dismissal follow the sidebar's terminal-menu convention;
 * Escape restores focus to the trigger, matching BranchChip.
 */
const rowText =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";

export function WorktreeChip({
  worktree,
  tabId,
  hostLocalActions,
  className,
}: {
  worktree: SessionWorktree;
  tabId: string;
  hostLocalActions: boolean;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  /** null = never asked; asked once per mount, like the sidebar's discovery. */
  const [vsCodeAvailable, setVsCodeAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openFinishWorktree = useStore((s) => s.openFinishWorktree);
  const displayedError = error;

  /** The trigger's wrapper; the portaled panel is tracked separately. */
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * The portaled popover. useDismissal tests DOM containment and the panel
   * lives under document.body — outside rootRef — so it must be its own ref;
   * otherwise every pointerdown on a row dismisses the popover before the
   * click can land (SessionHud's pattern).
   */
  const panelRef = useRef<HTMLDivElement>(null);

  const close = (): void => {
    setOpen(false);
    setError(null);
  };

  const toggle = (): void => {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    setPos(rect ? { x: rect.left, y: rect.bottom + 4 } : null);
    setOpen(true);
    if (hostLocalActions && vsCodeAvailable === null) {
      backend
        .getProjectOpenAvailability()
        .then((a) => setVsCodeAvailable(a.vsCode))
        .catch(() => setVsCodeAvailable(false));
    }
  };

  // Click-outside / Escape dismissal, matching BranchChip. The trigger is
  // inside rootRef and the portaled panel is panelRef, so a pointerdown on
  // either is not an outside click — the trigger's own onClick toggles, and
  // the popover closes exactly once.
  useDismissal({
    open,
    refs: [rootRef, panelRef],
    onClose: close,
    onEscape: close,
    restoreFocus: () => triggerRef.current?.focus(),
  });

  const openIn = (target: "vscode" | "files"): void => {
    setError(null);
    backend.openProject(worktree.path, target).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
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
          <div ref={panelRef} role="menu" className="fixed z-50" style={{ left: pos.x, top: pos.y }}>
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
                <CopyButton text={worktree.branch} label={t("worktree.actions.copy")} doneLabel={t("worktree.actions.copied")} />
              </div>
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span
                  className="min-w-0 truncate font-mono text-[10px] text-ink-faint"
                  title={worktree.path}
                >
                  {worktree.path}
                </span>
                <CopyButton text={worktree.path} label={t("worktree.actions.copy")} doneLabel={t("worktree.actions.copied")} />
              </div>
              {worktree.base !== null && (
                <p className="px-2.5 pb-1.5 text-[10px] text-ink-faint" title={worktree.base}>
                  {t("worktree.details.cutFrom", { base: shortBase(worktree.base) })}
                </p>
              )}
              <div className="my-1 border-t border-line-soft" />
              <button
                type="button"
                role="menuitem"
                className={rowText}
                onClick={() => {
                  close();
                  openFinishWorktree(tabId);
                }}
              >
                {t("worktree.actions.finish")}
              </button>
              {hostLocalActions && (
                <>
                  {vsCodeAvailable === true && (
                    <button type="button" role="menuitem" className={rowText} onClick={() => openIn("vscode")}>
                      {t("worktree.actions.openVsCode")}
                    </button>
                  )}
                  <button type="button" role="menuitem" className={rowText} onClick={() => openIn("files")}>
                    {t("worktree.actions.openFiles")}
                  </button>
                </>
              )}
              {displayedError !== null && (
                <p role="alert" className="px-2.5 py-1.5 text-[10px] leading-relaxed text-rose">
                  {displayedError}
                </p>
              )}
            </Panel>
          </div>,
          document.body,
        )}
    </span>
  );
}
