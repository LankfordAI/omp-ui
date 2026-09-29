// The subagent control strip (issue #684, ADR-0040): steer/kill/revive for
// one roster row, shared by the Agents pane and the subagent view banner.
// Every press dispatches a hidden bridge frame through the store slice; the
// result — ok or omp's own refusal sentence — lands on the snapshot publish.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { useDismissal } from "../lib/use-dismissal";
import { useStore } from "../store";
import { ICON_STROKE, IconButton } from "./ui";

/** Nominal steer-popover width; narrower only when the viewport cannot hold it. */
const POPOVER_WIDTH = 256;
const POPOVER_GAP = 4;
const VIEWPORT_EDGE = 8;

interface PopoverGeometry {
  left: number;
  top: number;
  width: number;
}

function IconSteer({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className ?? "size-3.5"}>
      <path d="M2.5 12.5c1.2-4.2 4.2-6.5 9-6.5" {...ICON_STROKE} />
      <path d="M9.5 3.5L12 6l-2.5 2.5" {...ICON_STROKE} />
      <path d="M12.5 9v4" {...ICON_STROKE} />
    </svg>
  );
}

function IconKill() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <circle cx="8" cy="8" r="5.4" {...ICON_STROKE} />
      <path d="M4.2 4.2l7.6 7.6" {...ICON_STROKE} />
    </svg>
  );
}

function IconRevive() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M5 3.5L11.5 8 5 12.5z" {...ICON_STROKE} />
    </svg>
  );
}

/**
 * The status half of the gating table (issue #684), mirroring what the bridge
 * accepts: live-ish statuses steer (mid-turn, or start its next turn) and
 * kill; parked revives (ensureLive) and kills (tombstoned release); every
 * other status — aborted, settled, released, unknown — offers nothing,
 * matching the bridge's refusals.
 */
export function subagentControlOffers(status: string): {
  steer: boolean;
  revive: boolean;
  kill: boolean;
} {
  const live = status === "running" || status === "active" || status === "pending" || status === "queued";
  const parked = status === "parked";
  return { steer: live, revive: parked, kill: live || parked };
}

export function SubagentControls({
  tabId,
  agentId,
  status,
}: {
  tabId: string;
  agentId: string;
  status: string;
}) {
  const t = useT();
  // A terminal tab has no RpcTabState at all, so `accepts` covers the mode:
  // omp's own subagent UX stays the PTY path's only one.
  const accepts = useStore(
    (s) =>
      s.rpc[tabId] !== undefined &&
      s.rpc[tabId].status !== "starting" &&
      s.rpc[tabId].commandAdmissionBlocked !== true,
  );
  const busy = useStore((s) => s.rpc[tabId]?.subagentControlBusy[agentId] !== undefined);
  const steerSubagent = useStore((s) => s.steerSubagent);
  const killSubagent = useStore((s) => s.killSubagent);
  const reviveSubagent = useStore((s) => s.reviveSubagent);
  const [steerOpen, setSteerOpen] = useState(false);
  const [text, setText] = useState("");
  const triggerRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<PopoverGeometry | null>(null);

  const verbs = subagentControlOffers(status);
  const usable = accepts;

  useLayoutEffect(() => {
    if (!steerOpen) return;
    const place = (): void => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const viewportLeft = visualViewport?.offsetLeft ?? 0;
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportWidth = visualViewport?.width ?? window.innerWidth;
      const width = Math.min(POPOVER_WIDTH, Math.max(0, viewportWidth - VIEWPORT_EDGE * 2));
      const minLeft = viewportLeft + VIEWPORT_EDGE;
      const maxLeft = viewportLeft + viewportWidth - VIEWPORT_EDGE - width;
      setGeometry({
        left: Math.max(minLeft, Math.min(rect.right - width, maxLeft)),
        top: Math.max(viewportTop + VIEWPORT_EDGE, rect.bottom + POPOVER_GAP),
        width,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [steerOpen]);

  useEffect(() => {
    if (steerOpen) inputRef.current?.focus({ preventScroll: true });
  }, [steerOpen]);

  // Fail closed: a press outside the trigger and the portaled panel dismisses.
  useDismissal({
    open: steerOpen,
    refs: [triggerRef, panelRef],
    onClose: () => setSteerOpen(false),
    onEscape: () => setSteerOpen(false),
    restoreFocus: () => {
      const button = triggerRef.current?.querySelector("button");
      if (button instanceof HTMLElement) button.focus();
    },
  });

  if (!verbs.steer && !verbs.revive && !verbs.kill) return null;

  const sendSteer = (): void => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setSteerOpen(false);
    setText("");
    void steerSubagent(tabId, agentId, trimmed);
  };

  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {verbs.steer && (
        <span ref={triggerRef}>
          <IconButton
            label={t("rail.agents.steer")}
            disabled={!usable || busy}
            onClick={() => setSteerOpen((value) => !value)}
            className="size-5"
          >
            <IconSteer />
          </IconButton>
        </span>
      )}
      {verbs.revive && (
        <IconButton
          label={t("rail.agents.revive")}
          disabled={!usable || busy}
          onClick={() => void reviveSubagent(tabId, agentId)}
          className="size-5"
        >
          <IconRevive />
        </IconButton>
      )}
      {verbs.kill && (
        <IconButton
          label={t("rail.agents.kill")}
          tone="rose"
          disabled={!usable || busy}
          onClick={() => void killSubagent(tabId, agentId)}
          className="size-5"
        >
          <IconKill />
        </IconButton>
      )}
      {steerOpen &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("rail.agents.steer")}
            tabIndex={-1}
            className="fixed z-[70] rounded-lg border border-line bg-raised p-2 shadow-xl"
            style={{
              left: geometry?.left ?? 0,
              top: geometry?.top ?? 0,
              width: geometry?.width ?? POPOVER_WIDTH,
            }}
          >
            <textarea
              ref={inputRef}
              rows={3}
              value={text}
              placeholder={t("rail.agents.steerPlaceholder")}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendSteer();
                }
              }}
              className="w-full resize-none rounded-md border border-line bg-transparent px-1.5 py-1 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
            />
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                onClick={sendSteer}
                disabled={text.trim() === ""}
                className="rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-ink-mid transition-colors hover:bg-hover disabled:cursor-default disabled:text-ink-faint"
              >
                {t("rail.agents.steerSend")}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * The row-level refusal line: a local refusal (slice) wins over the bridge's
 * own last failed result; cleared by the next dispatch or publish.
 */
export function useSubagentControlNotice(tabId: string): string | null {
  return useStore((s) => {
    const tab = s.rpc[tabId];
    if (tab === undefined) return null;
    if (tab.subagentControlError !== null) return tab.subagentControlError;
    const results = tab.subagentControl?.results;
    if (results === undefined || results.length === 0) return null;
    const last = results[results.length - 1];
    return last !== undefined && !last.ok ? (last.error ?? null) : null;
  });
}
