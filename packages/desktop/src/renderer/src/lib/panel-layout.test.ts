import { describe, expect, it } from "vitest";
import {
  COLLAPSED_SIDEBAR_WIDTH,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampPanelWidth,
  resolveDesktopPanelWidths,
} from "./panel-layout";

describe("desktop panel layout", () => {
  it("clamps preferences and defaults non-finite input", () => {
    expect(clampPanelWidth("sidebar", 1)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampPanelWidth("sidebar", 999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampPanelWidth("sidebar", Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampPanelWidth("inspector", 1)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampPanelWidth("inspector", 999)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampPanelWidth("inspector", Number.POSITIVE_INFINITY)).toBe(INSPECTOR_DEFAULT_WIDTH);
  });

  it("reduces the inspector first when the 900px desktop budget is exceeded", () => {
    expect(resolveDesktopPanelWidths({
      viewportWidth: 900,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
      sidebarCollapsed: false,
      inspectorOpen: true,
    })).toEqual({
      sidebarWidth: 272,
      inspectorWidth: 268,
      sidebarAllowedMax: 272,
      inspectorAllowedMax: 268,
    });
  });

  it("excludes collapsed and closed panes from the variable budget", () => {
    const collapsed = resolveDesktopPanelWidths({
      viewportWidth: 900,
      sidebarWidth: 512,
      inspectorWidth: 480,
      sidebarCollapsed: true,
      inspectorOpen: true,
    });
    expect(collapsed.sidebarWidth).toBe(COLLAPSED_SIDEBAR_WIDTH);
    expect(collapsed.inspectorWidth).toBe(480);

    const closed = resolveDesktopPanelWidths({
      viewportWidth: 900,
      sidebarWidth: 512,
      inspectorWidth: 480,
      sidebarCollapsed: false,
      inspectorOpen: false,
    });
    expect(closed.sidebarWidth).toBe(512);
    expect(closed.inspectorWidth).toBe(0);
  });

  it("preserves wide viewport preferences", () => {
    expect(resolveDesktopPanelWidths({
      viewportWidth: 1200,
      sidebarWidth: 416,
      inspectorWidth: 256,
      sidebarCollapsed: false,
      inspectorOpen: true,
    })).toMatchObject({ sidebarWidth: 416, inspectorWidth: 256 });
  });
});
