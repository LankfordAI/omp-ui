export const SIDEBAR_DEFAULT_WIDTH = 272;
export const SIDEBAR_MIN_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 512;
export const INSPECTOR_DEFAULT_WIDTH = 304;
export const INSPECTOR_MIN_WIDTH = 224;
export const INSPECTOR_MAX_WIDTH = 480;
export const COLLAPSED_SIDEBAR_WIDTH = 56;
export const INSPECTOR_STRIP_WIDTH = 40;
export const MAIN_CONTENT_MIN_WIDTH = 320;
export const PANEL_KEYBOARD_STEP = 16;

export type DesktopPanel = "sidebar" | "inspector";

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
}

export interface DesktopPanelWidths {
  sidebarWidth: number;
  inspectorWidth: number;
  sidebarAllowedMax: number;
  inspectorAllowedMax: number;
}

/**
 * Resolves committed preferences against the shared desktop width budget.
 * The inspector yields first, then the project sidebar. Permanent chrome and
 * the transcript reserve are never counted as resizable space.
 */
export function resolveDesktopPanelWidths({
  viewportWidth,
  sidebarWidth,
  inspectorWidth,
  sidebarCollapsed,
  inspectorOpen,
}: DesktopPanelWidthsInput): DesktopPanelWidths {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const sidebarPreference = clampPanelWidth("sidebar", sidebarWidth);
  const inspectorPreference = clampPanelWidth("inspector", inspectorWidth);
  const fixed = MAIN_CONTENT_MIN_WIDTH + INSPECTOR_STRIP_WIDTH +
    (sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : 0);
  const variableBudget = Math.max(0, viewport - fixed);

  let effectiveSidebar = sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarPreference;
  let effectiveInspector = inspectorOpen ? inspectorPreference : 0;

  if (!sidebarCollapsed && inspectorOpen) {
    let overflow = Math.max(0, effectiveSidebar + effectiveInspector - variableBudget);
    const inspectorReduction = Math.min(overflow, Math.max(0, effectiveInspector - INSPECTOR_MIN_WIDTH));
    effectiveInspector -= inspectorReduction;
    overflow -= inspectorReduction;
    effectiveSidebar -= Math.min(overflow, Math.max(0, effectiveSidebar - SIDEBAR_MIN_WIDTH));
  } else if (!sidebarCollapsed) {
    effectiveSidebar = Math.min(effectiveSidebar, Math.max(SIDEBAR_MIN_WIDTH, variableBudget));
  } else if (inspectorOpen) {
    effectiveInspector = Math.min(effectiveInspector, Math.max(INSPECTOR_MIN_WIDTH, variableBudget));
  }

  const sidebarAllowedMax = sidebarCollapsed
    ? SIDEBAR_MAX_WIDTH
    : Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, variableBudget - (inspectorOpen ? effectiveInspector : 0)),
      );
  const inspectorAllowedMax = !inspectorOpen
    ? INSPECTOR_MAX_WIDTH
    : Math.max(
        INSPECTOR_MIN_WIDTH,
        Math.min(
          INSPECTOR_MAX_WIDTH,
          variableBudget - (sidebarCollapsed ? 0 : effectiveSidebar),
        ),
      );

  return {
    sidebarWidth: effectiveSidebar,
    inspectorWidth: effectiveInspector,
    sidebarAllowedMax,
    inspectorAllowedMax,
  };
}
