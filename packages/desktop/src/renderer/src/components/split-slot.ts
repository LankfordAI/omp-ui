import {
  resolveDesktopPanelWidths,
  type DesktopPanelWidths,
  type SplitKind,
  type SplitSlot,
} from "../lib/panel-layout";
import { useCompactShell, useViewportWidth } from "../lib/responsive";
import { useStore } from "../store";

/**
 * The pane taking a tab's split column right now — the one fact the shared
 * width budget needs. A fullscreen pane owns the transcript column instead,
 * and the compact shell has no columns at all. The width is the matching
 * store preference.
 */
export function useSplitSlot(tabId: string | null): SplitSlot | null {
  const compact = useCompactShell();
  const kind = useStore((s): SplitKind | null => {
    const rpc = tabId === null ? undefined : s.rpc[tabId];
    const browser = rpc?.browserPane;
    if (browser?.open === true) return browser.fullscreen ? null : "browserPane";
    const device = rpc?.devicePane;
    if (device?.open === true) return device.fullscreen ? null : "devicePane";
    return null;
  });
  const browserPaneWidth = useStore((s) => s.browserPaneWidth);
  const devicePaneWidth = useStore((s) => s.devicePaneWidth);
  if (compact || kind === null) return null;
  return { kind, width: kind === "browserPane" ? browserPaneWidth : devicePaneWidth };
}

/** The desktop width budget with this tab's split pane counted in. */
export function useDesktopPanelWidths(tabId: string): DesktopPanelWidths {
  const viewportWidth = useViewportWidth();
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const inspectorWidth = useStore((s) => s.inspectorWidth);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const split = useSplitSlot(tabId);
  return resolveDesktopPanelWidths({
    viewportWidth,
    sidebarWidth,
    inspectorWidth,
    sidebarCollapsed,
    inspectorOpen,
    split,
  });
}
