// PROTOTYPE (#527) — throwaway. Variant A (a resizable split beside the
// transcript) and variant C (a full-column view like SubagentView). Variant B
// has no component of its own — it is a branch inside InspectorRail.
import { useState } from "react";
import { cn } from "../../lib/cn";
import {
  COLLAPSED_SIDEBAR_WIDTH,
  INSPECTOR_STRIP_WIDTH,
  MAIN_CONTENT_MIN_WIDTH,
  resolveDesktopPanelWidths,
} from "../../lib/panel-layout";
import { useCompactShell, useViewportWidth } from "../../lib/responsive";
import { useStore } from "../../store";
import { IconButton, IconClose, Label, ResizeHandle, Sheet } from "../ui";
import { BrowserPaneBody, BrowserToolbar, FrameCanvas } from "./pane";
import { SPLIT_DEFAULT_WIDTH, SPLIT_MIN_WIDTH, setPaneOpen, setSplitWidth, useBrowserPane } from "./state";

/* -------------------------------------------------------------- A: split */

/**
 * A sibling column in the tab's flex row, mirroring the rail pane's
 * structure. The split does NOT join the sidebar/inspector yield budget —
 * a finding for #528, not something to solve here.
 */
export function BrowserSplit({ tabId }: { tabId: string }) {
  const pane = useBrowserPane(tabId);
  const compact = useCompactShell();
  const viewportWidth = useViewportWidth();
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const inspectorWidth = useStore((s) => s.inspectorWidth);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const [preview, setPreview] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  if (!pane.open) return null;

  if (compact) {
    return (
      <Sheet open placement="bottom" label="Browser" onClose={() => setPaneOpen(tabId, false)}>
        <div className="flex h-[70dvh] flex-col">
          <BrowserPaneBody tabId={tabId} dense />
        </div>
      </Sheet>
    );
  }

  const r = resolveDesktopPanelWidths({ viewportWidth, sidebarWidth, inspectorWidth, sidebarCollapsed, inspectorOpen });
  const chrome =
    (sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : r.sidebarWidth) +
    INSPECTOR_STRIP_WIDTH +
    r.inspectorWidth +
    MAIN_CONTENT_MIN_WIDTH;
  const allowedMax = Math.max(SPLIT_MIN_WIDTH, viewportWidth - chrome);
  const shown = Math.min(preview ?? pane.splitWidth, allowedMax);

  return (
    <div
      className={cn(
        "relative flex shrink-0 flex-col border-l border-line bg-surface",
        !resizing && "transition-[width] duration-200 ease-out-quint",
      )}
      style={{ width: shown }}
    >
      <ResizeHandle
        label="resize browser pane"
        edge="left"
        value={shown}
        min={SPLIT_MIN_WIDTH}
        max={allowedMax}
        defaultValue={SPLIT_DEFAULT_WIDTH}
        onPreview={setPreview}
        onCommit={(w) => {
          setSplitWidth(tabId, w);
          setPreview(null);
        }}
        onDraggingChange={setResizing}
      />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2.5">
        <Label className="min-w-0 flex-1 truncate">Browser</Label>
        <IconButton label="close browser pane" onClick={() => setPaneOpen(tabId, false)}>
          <IconClose className="size-3.5" />
        </IconButton>
      </div>
      <BrowserPaneBody tabId={tabId} />
    </div>
  );
}

/* ------------------------------------------------------------- C: column */

/**
 * Takes over the transcript slot the way SubagentView does, but keeps the
 * floating composer: the user prompts the agent while watching the page. The
 * frame reserves --transcript-bottom-inset (RpcTab's composer reserve) as
 * padding — a web page under glass is neither readable nor clickable. In the
 * compact shell the composer is in flow and the inset is unset.
 */
export function BrowserColumnView({ tabId }: { tabId: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2">
        <button
          type="button"
          onClick={() => setPaneOpen(tabId, false)}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-ink-faint transition-colors hover:bg-hover hover:text-ink-mid"
        >
          ← transcript
        </button>
        <div className="min-w-0 flex-1">
          <BrowserToolbar tabId={tabId} className="border-b-0 px-0 py-0" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col" style={{ paddingBottom: "var(--transcript-bottom-inset, 0px)" }}>
        <FrameCanvas tabId={tabId} />
      </div>
    </div>
  );
}
