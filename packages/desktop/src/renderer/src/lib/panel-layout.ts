export const SIDEBAR_DEFAULT_WIDTH = 312;
export const SIDEBAR_MIN_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 512;
export const INSPECTOR_DEFAULT_WIDTH = 304;
export const INSPECTOR_MIN_WIDTH = 224;
export const INSPECTOR_MAX_WIDTH = 480;
export const INSPECTOR_STRIP_WIDTH = 60;
export const BROWSER_PANE_DEFAULT_WIDTH = 560;
export const BROWSER_PANE_MIN_WIDTH = 360;
export const BROWSER_PANE_MAX_WIDTH = 1600;
export const DEVICE_PANE_DEFAULT_WIDTH = 420;
export const DEVICE_PANE_MIN_WIDTH = 300;
export const DEVICE_PANE_MAX_WIDTH = 900;
export const MAIN_CONTENT_MIN_WIDTH = 320;
/**
 * The desktop transcript floor while no split pane shares the column
 * (issue #1042): with only sidebar + inspector competing, they used to yield
 * just after the bare 320px collapse guard, so two maxed panes could starve
 * the prose. Round 0 measured ~460px of transcript beside an open rail; now
 * the chrome gives room before the column falls under a readable measure.
 * A split pane is deliberate content, so its posture keeps the old guard.
 */
export const DESKTOP_CONTENT_MIN_WIDTH = 560;
export const PANEL_KEYBOARD_STEP = 16;

/** The inspector rail's panes; InspectorRail groups them (Work, Review, Ask, Info). */
export type RailTab = "todos" | "agents" | "jobs" | "session" | "plans" | "diffs" | "btw" | "seance";

export type DesktopPanel = "sidebar" | "inspector" | "browserPane" | "devicePane";

/** The panes that can take the split column beside the transcript. */
export type SplitKind = "browserPane" | "devicePane";

/** The pane occupying the split column, at its stored width preference. */
export interface SplitSlot {
  kind: SplitKind;
  width: number;
}

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
  devicePane: {
    defaultWidth: DEVICE_PANE_DEFAULT_WIDTH,
    min: DEVICE_PANE_MIN_WIDTH,
    max: DEVICE_PANE_MAX_WIDTH,
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
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  /** The pane taking a split column beside the transcript, or null when none does. */
  split: SplitSlot | null;
}

export interface DesktopPanelWidths {
  sidebarWidth: number;
  inspectorWidth: number;
  splitWidth: number;
  sidebarAllowedMax: number;
  inspectorAllowedMax: number;
  splitAllowedMax: number;
  /**
   * False when the split budget cannot hold the split pane at its minimum
   * beside the transcript reserve; the pane then renders in the column posture
   * without touching its stored fullscreen flag.
   */
  splitFits: boolean;
}

/**
 * Resolves committed preferences against the shared desktop width budget.
 * The inspector yields first, then the project sidebar, then the split pane.
 * Permanent chrome and the transcript reserve are never counted as resizable
 * space.
 */
export function resolveDesktopPanelWidths({
  viewportWidth,
  sidebarWidth,
  inspectorWidth,
  sidebarCollapsed,
  inspectorOpen,
  split,
}: DesktopPanelWidthsInput): DesktopPanelWidths {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const sidebarPreference = clampPanelWidth("sidebar", sidebarWidth);
  const inspectorPreference = clampPanelWidth("inspector", inspectorWidth);
  const splitBounds = split === null ? null : PANEL_BOUNDS[split.kind];
  // No split pane means the column is prose: it keeps its readable measure.
  // A split pane is deliberate content beside the transcript, so only the
  // bare collapse guard applies (issue #1042).
  const contentMin = split === null ? DESKTOP_CONTENT_MIN_WIDTH : MAIN_CONTENT_MIN_WIDTH;
  const fixed = contentMin + INSPECTOR_STRIP_WIDTH;
  const variableBudget = Math.max(0, viewport - fixed);

  // The variable set: every open/expanded pane at its preference, reduced in
  // yield order (inspector, sidebar, split pane) down to its minimum until
  // the set fits the budget. A pane outside the set contributes 0.
  let effectiveSidebar = sidebarCollapsed ? 0 : sidebarPreference;
  let effectiveInspector = inspectorOpen ? inspectorPreference : 0;
  let effectiveSplit = split === null ? 0 : clampPanelWidth(split.kind, split.width);
  let overflow = Math.max(0, effectiveSidebar + effectiveInspector + effectiveSplit - variableBudget);
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
  if (splitBounds !== null) {
    effectiveSplit -= Math.min(overflow, Math.max(0, effectiveSplit - splitBounds.min));
  }

  // Each pane's ceiling is what the budget leaves after the others' effective
  // widths, never below its own minimum so the resize handle keeps a range.
  const sidebarAllowedMax = sidebarCollapsed
    ? SIDEBAR_MAX_WIDTH
    : Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, variableBudget - effectiveInspector - effectiveSplit),
      );
  const inspectorAllowedMax = !inspectorOpen
    ? INSPECTOR_MAX_WIDTH
    : Math.max(
        INSPECTOR_MIN_WIDTH,
        Math.min(INSPECTOR_MAX_WIDTH, variableBudget - effectiveSidebar - effectiveSplit),
      );
  const splitRoom = variableBudget - effectiveSidebar - effectiveInspector;
  if (splitBounds !== null && splitRoom < splitBounds.min) {
    // The pane falls back to the column posture, so the split it reserved is
    // not rendered: the sidebar and inspector get the budget back.
    return {
      ...resolveDesktopPanelWidths({
        viewportWidth,
        sidebarWidth,
        inspectorWidth,
        sidebarCollapsed,
        inspectorOpen,
        split: null,
      }),
      splitFits: false,
    };
  }
  const splitAllowedMax =
    splitBounds === null
      ? BROWSER_PANE_MAX_WIDTH
      : Math.max(splitBounds.min, Math.min(splitBounds.max, splitRoom));

  return {
    sidebarWidth: effectiveSidebar,
    inspectorWidth: effectiveInspector,
    splitWidth: effectiveSplit,
    sidebarAllowedMax,
    inspectorAllowedMax,
    splitAllowedMax,
    splitFits: true,
  };
}

export interface DockedSidebarWidth {
  sidebarWidth: number;
  sidebarAllowedMax: number;
  /** True when the hinge, not the preference, sets the width: no resize handle. */
  pinned: boolean;
}

/** The compact shell's docked sidebar: only the transcript reserve is fixed; a book-posture hinge pins the width. */
export function resolveDockedSidebarWidth(
  viewportWidth: number,
  sidebarWidth: number,
  hingeX: number | null,
): DockedSidebarWidth {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const sidebarAllowedMax = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewport - MAIN_CONTENT_MIN_WIDTH));
  const clampToRoom = (width: number) => Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarAllowedMax, width));
  if (hingeX !== null && Number.isFinite(hingeX)) {
    return { sidebarWidth: clampToRoom(hingeX), sidebarAllowedMax, pinned: true };
  }
  return { sidebarWidth: clampToRoom(clampPanelWidth("sidebar", sidebarWidth)), sidebarAllowedMax, pinned: false };
}
