import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import {
  BROWSER_PANE_DEFAULT_WIDTH,
  BROWSER_PANE_MIN_WIDTH,
  resolveDesktopPanelWidths,
  type DesktopPanelWidths,
} from "../../lib/panel-layout";
import { useCompactShell, useViewportWidth } from "../../lib/responsive";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { ResizeHandle } from "../ui";
import { BrowserPane } from "./BrowserPane";

/**
 * Whether a tab's browser pane is taking a split column right now — the one
 * fact the shared width budget needs (spec 6.2). A fullscreen pane owns the
 * transcript column instead, and the compact shell has no columns at all.
 */
export function useBrowserPaneSplitOpen(tabId: string | null): boolean {
  const compact = useCompactShell();
  const open = useStore((s) => {
    const pane = tabId === null ? undefined : s.rpc[tabId]?.browserPane;
    return pane?.open === true && !pane.fullscreen;
  });
  return open && !compact;
}

/** The desktop width budget with this tab's browser pane counted in. */
export function useDesktopPanelWidths(tabId: string): DesktopPanelWidths {
  const viewportWidth = useViewportWidth();
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const inspectorWidth = useStore((s) => s.inspectorWidth);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const browserPaneWidth = useStore((s) => s.browserPaneWidth);
  const browserPaneOpen = useBrowserPaneSplitOpen(tabId);
  return resolveDesktopPanelWidths({
    viewportWidth,
    sidebarWidth,
    inspectorWidth,
    sidebarCollapsed,
    inspectorOpen,
    browserPaneWidth,
    browserPaneOpen,
  });
}

/** The desktop split: the pane as a resizable column between the transcript and the inspector rail. */
export function BrowserPaneSplit({ tabId }: { tabId: string }) {
  const t = useT();
  const resolved = useDesktopPanelWidths(tabId);
  const browserPaneWidth = useStore((s) => s.browserPaneWidth);
  const setBrowserPaneWidth = useStore((s) => s.setBrowserPaneWidth);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    setPreviewWidth(null);
  }, [browserPaneWidth]);

  const displayedWidth = previewWidth ?? resolved.browserPaneWidth;

  return (
    <aside
     
      className={cn(
        "relative flex shrink-0 flex-col border-l border-line",
        !resizing && "transition-[width] duration-200 ease-out-quint",
      )}
      style={{ width: displayedWidth }}
    >
      <ResizeHandle
        label={t("browser.split.resize")}
        edge="left"
        value={displayedWidth}
        min={BROWSER_PANE_MIN_WIDTH}
        max={resolved.browserPaneAllowedMax}
        defaultValue={BROWSER_PANE_DEFAULT_WIDTH}
        onPreview={setPreviewWidth}
        onCommit={(width) => {
          setBrowserPaneWidth(width);
          setPreviewWidth(null);
        }}
        onDraggingChange={setResizing}
      />
      <BrowserPane tabId={tabId} posture="split" />
    </aside>
  );
}
