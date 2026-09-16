export const SIDEBAR_DEFAULT_WIDTH = 272;
export const SIDEBAR_MIN_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 512;
export const INSPECTOR_DEFAULT_WIDTH = 304;
export const INSPECTOR_MIN_WIDTH = 224;
export const INSPECTOR_MAX_WIDTH = 480;
export const COLLAPSED_SIDEBAR_WIDTH = 56;
export const INSPECTOR_STRIP_WIDTH = 40;
export const BROWSER_PANE_DEFAULT_WIDTH = 560;
export const BROWSER_PANE_MIN_WIDTH = 360;
export const BROWSER_PANE_MAX_WIDTH = 1600;
export const MAIN_CONTENT_MIN_WIDTH = 320;
export const PANEL_KEYBOARD_STEP = 16;

export type DesktopPanel = "sidebar" | "inspector" | "browserPane";

const PANEL_BOUNDS = {
  sidebar: {
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
  },
  inspector: {
    defaultWidth: INSPECTOR_DEFAULT_WIDTH,
    min: INSPECTOR_MIN_WIDTH,
    max: INSPECTOR_MAX_WIDTH,
  },
  browserPane: {
    defaultWidth: BROWSER_PANE_DEFAULT_WIDTH,
    min: BROWSER_PANE_MIN_WIDTH,
    max: BROWSER_PANE_MAX_WIDTH,
  },
} as const;

export function clampPanelWidth(panel: DesktopPanel, value: number): number {
  const bounds = PANEL_BOUNDS[panel];
  const finite = Number.isFinite(value) ? value : bounds.defaultWidth;
  return Math.min(bounds.max, Math.max(bounds.min, finite));
}

export interface DesktopPanelWidthsInput {
  viewportWidth: number;
  sidebarWidth: number;
  inspectorWidth: number;
  browserPaneWidth: number;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  /** True while the browser pane takes a split column beside the transcript. */
  browserPaneOpen: boolean;
}

export interface DesktopPanelWidths {
  sidebarWidth: number;
  inspectorWidth: number;
  browserPaneWidth: number;
  sidebarAllowedMax: number;
  inspectorAllowedMax: number;
  browserPaneAllowedMax: number;
  /**
   * False when the split budget cannot hold the pane at its minimum beside the
   * transcript reserve; the pane then renders in the column posture without
   * touching the stored fullscreen flag.
   */
  browserPaneFits: boolean;
}

/**
 * Resolves committed preferences against the shared desktop width budget.
 * The inspector yields first, then the project sidebar, then the browser
 * pane. Permanent chrome and the transcript reserve are never counted as
 * resizable space.
 */
export function resolveDesktopPanelWidths({
  viewportWidth,
  sidebarWidth,
  inspectorWidth,
  browserPaneWidth,
  sidebarCollapsed,
  inspectorOpen,
  browserPaneOpen,
}: DesktopPanelWidthsInput): DesktopPanelWidths {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const sidebarPreference = clampPanelWidth("sidebar", sidebarWidth);
  const inspectorPreference = clampPanelWidth("inspector", inspectorWidth);
  const browserPanePreference = clampPanelWidth("browserPane", browserPaneWidth);
  const fixed = MAIN_CONTENT_MIN_WIDTH + INSPECTOR_STRIP_WIDTH +
    (sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : 0);
  const variableBudget = Math.max(0, viewport - fixed);

  // The variable set: every open/expanded pane at its preference, reduced in
  // yield order (inspector, sidebar, browser pane) down to its minimum until
  // the set fits the budget. A pane outside the set contributes 0.
  let effectiveSidebar = sidebarCollapsed ? 0 : sidebarPreference;
  let effectiveInspector = inspectorOpen ? inspectorPreference : 0;
  let effectiveBrowserPane = browserPaneOpen ? browserPanePreference : 0;
  let overflow = Math.max(
    0,
    effectiveSidebar + effectiveInspector + effectiveBrowserPane - variableBudget,
  );
  if (inspectorOpen) {
    const reduction = Math.min(overflow, Math.max(0, effectiveInspector - INSPECTOR_MIN_WIDTH));
    effectiveInspector -= reduction;
    overflow -= reduction;
  }
  if (!sidebarCollapsed) {
    const reduction = Math.min(overflow, Math.max(0, effectiveSidebar - SIDEBAR_MIN_WIDTH));
    effectiveSidebar -= reduction;
    overflow -= reduction;
  }
  if (browserPaneOpen) {
    effectiveBrowserPane -= Math.min(
      overflow,
      Math.max(0, effectiveBrowserPane - BROWSER_PANE_MIN_WIDTH),
    );
  }

  // Each pane's ceiling is what the budget leaves after the others' effective
  // widths, never below its own minimum so the resize handle keeps a range.
  const sidebarAllowedMax = sidebarCollapsed
    ? SIDEBAR_MAX_WIDTH
    : Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, variableBudget - effectiveInspector - effectiveBrowserPane),
      );
  const inspectorAllowedMax = !inspectorOpen
    ? INSPECTOR_MAX_WIDTH
    : Math.max(
        INSPECTOR_MIN_WIDTH,
        Math.min(INSPECTOR_MAX_WIDTH, variableBudget - effectiveSidebar - effectiveBrowserPane),
      );
  const browserPaneRoom = variableBudget - effectiveSidebar - effectiveInspector;
  const browserPaneAllowedMax = !browserPaneOpen
    ? BROWSER_PANE_MAX_WIDTH
    : Math.max(BROWSER_PANE_MIN_WIDTH, Math.min(BROWSER_PANE_MAX_WIDTH, browserPaneRoom));

  return {
    sidebarWidth: sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : effectiveSidebar,
    inspectorWidth: effectiveInspector,
    browserPaneWidth: effectiveBrowserPane,
    sidebarAllowedMax,
    inspectorAllowedMax,
    browserPaneAllowedMax,
    browserPaneFits: !browserPaneOpen || browserPaneRoom >= BROWSER_PANE_MIN_WIDTH,
  };
}
