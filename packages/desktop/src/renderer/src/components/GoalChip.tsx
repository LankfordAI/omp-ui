import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GoalState } from "@omp-ui/core/goal";
import { cn } from "../lib/cn";
import { exactNum } from "../lib/format";
import { goalDetails } from "../lib/goal-format";
import { useT } from "../lib/i18n";
import { useDismissal } from "../lib/use-dismissal";
import { useStore } from "../store";
import { Button, Chip, Dot, Panel, type Tone } from "./ui";

/** Panel width (18rem) in px, so a chip near the right edge keeps its panel on screen. */
const PANEL_WIDTH_PX = 288;
const EDGE_GAP_PX = 8;

/**
 * One session's goal, as omp's native goal state reports it (issue #381,
 * ADR-0046). The chip is the glanceable half — is a goal running, is it
 * waiting on me, how much budget is left; the objective lives in the
 * accessible name and the popover, never in HUD chrome. Clicking opens goal
 * controls: pause or resume as the status allows, and a two-step drop.
 */
export function GoalChip({
  state,
  tabId,
  className,
}: {
  state: GoalState;
  tabId: string;
  className?: string;
}) {
  const t = useT();
  const runSlashCommand = useStore((s) => s.runSlashCommand);
  const goal = state.goal;
  const [open, setOpen] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Portaled + fixed, like the HUD's modes popover: the wide HUD root is
  // overflow-hidden inside the title bar, so an in-tree panel is clipped.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const maxLeft = window.innerWidth - PANEL_WIDTH_PX - EDGE_GAP_PX;
      setPos({ top: rect.bottom + 6, left: Math.max(EDGE_GAP_PX, Math.min(rect.left, maxLeft)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Closing resets the drop confirmation: a half-confirmed drop never
  // survives the popover it was armed in.
  const close = () => {
    setOpen(false);
    setConfirmDrop(false);
  };
  useDismissal({ open, refs: [anchor, panelRef], onClose: close, onEscape: close });

  const run = (line: "/goal pause" | "/goal resume" | "/goal drop") => {
    void runSlashCommand(tabId, line);
    close();
  };

  const tone: Tone = goal.status === "active" ? "signal" : "copper";
  const label =
    goal.status === "active"
      ? t("hud.goal.active")
      : goal.status === "paused"
        ? t("hud.goal.paused")
        : goal.status === "budget-limited"
          ? t("hud.goal.limited")
          : t("hud.goal.complete");
  const title =
    goal.status === "active"
      ? t("hud.goal.objective", { objective: goal.objective })
      : goal.status === "paused"
        ? t("hud.goal.pausedObjective", { objective: goal.objective })
        : goal.status === "budget-limited"
          ? t("hud.goal.limitedObjective", { objective: goal.objective })
          : t("hud.goal.completeObjective", { objective: goal.objective });
  const usage =
    goal.tokenBudget === null
      ? t("hud.goal.unbounded", { used: exactNum(goal.tokensUsed) })
      : t("hud.goal.usage", {
          used: exactNum(goal.tokensUsed),
          budget: exactNum(goal.tokenBudget),
        });
  // goalDetails ends with the tokens and elapsed lines; the objective (which
  // may span lines) gets its own scrollable block, and the chip names the status.
  const detailLines = open ? goalDetails(state).split("\n").slice(-2) : [];
  const canPause = goal.status === "active" || goal.status === "budget-limited";

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={`${title} — ${usage}. ${t("hud.goal.openTitle")}`}
        aria-label={title}
        aria-expanded={open}
        className={cn("shrink-0 rounded border border-transparent", className)}
      >
        <Chip tone={tone} mono>
          {goal.status === "active" && <Dot tone="signal" />}
          {label}
          <span className="opacity-70">{usage}</span>
        </Chip>
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} className="fixed z-[70]" style={pos}>
          <Panel className="edge-lit animate-rise w-[18rem] p-2.5">
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] text-ink">
              {goal.objective}
            </p>
            <div className="mt-2 space-y-0.5 font-mono text-[10px] text-ink-faint">
              {detailLines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-end gap-2 border-t border-line-soft pt-2.5">
              {confirmDrop ? (
                <>
                  <Button variant="ghost" size="xs" onClick={() => setConfirmDrop(false)}>
                    {t("hud.goal.cancel")}
                  </Button>
                  <Button variant="ghost" size="xs" tone="rose" onClick={() => run("/goal drop")}>
                    {t("hud.goal.dropConfirm")}
                  </Button>
                </>
              ) : (
                <>
                  {canPause && (
                    <Button variant="ghost" size="xs" onClick={() => run("/goal pause")}>
                      {t("hud.goal.pause")}
                    </Button>
                  )}
                  {goal.status === "paused" && (
                    <Button variant="ghost" size="xs" onClick={() => run("/goal resume")}>
                      {t("hud.goal.resume")}
                    </Button>
                  )}
                  <Button variant="ghost" size="xs" onClick={() => setConfirmDrop(true)}>
                    {t("hud.goal.drop")}
                  </Button>
                </>
              )}
            </div>
          </Panel>
        </div>,
        document.body,
      )}
    </>
  );
}
