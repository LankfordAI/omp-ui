import { describe, expect, it } from "vitest";
import {
  BROWSER_PANE_DEFAULT_WIDTH,
  BROWSER_PANE_MAX_WIDTH,
  BROWSER_PANE_MIN_WIDTH,
  COLLAPSED_SIDEBAR_WIDTH,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampPanelWidth,
  resolveDesktopPanelWidths,
  type DesktopPanelWidthsInput,
} from "./panel-layout";

/** Every pane at its default preference with the browser pane closed. */
const defaults: DesktopPanelWidthsInput = {
  viewportWidth: 1200,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  browserPaneWidth: BROWSER_PANE_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  inspectorOpen: true,
  browserPaneOpen: false,
};

describe("desktop panel layout", () => {
  it("clamps preferences and defaults non-finite input", () => {
    expect(clampPanelWidth("sidebar", 1)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampPanelWidth("sidebar", 999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampPanelWidth("sidebar", Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampPanelWidth("inspector", 1)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampPanelWidth("inspector", 999)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampPanelWidth("inspector", Number.POSITIVE_INFINITY)).toBe(INSPECTOR_DEFAULT_WIDTH);
    expect(clampPanelWidth("browserPane", 1)).toBe(BROWSER_PANE_MIN_WIDTH);
    expect(clampPanelWidth("browserPane", 9999)).toBe(BROWSER_PANE_MAX_WIDTH);
    expect(clampPanelWidth("browserPane", Number.NaN)).toBe(BROWSER_PANE_DEFAULT_WIDTH);
  });

  it("reduces the inspector first when the 900px desktop budget is exceeded", () => {
    expect(resolveDesktopPanelWidths({ ...defaults, viewportWidth: 900 })).toEqual({
      sidebarWidth: 272,
      inspectorWidth: 268,
      browserPaneWidth: 0,
      sidebarAllowedMax: 272,
      inspectorAllowedMax: 268,
      browserPaneAllowedMax: BROWSER_PANE_MAX_WIDTH,
      browserPaneFits: true,
    });
  });

  it("excludes collapsed and closed panes from the variable budget", () => {
    const collapsed = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 900,
      sidebarWidth: 512,
      inspectorWidth: 480,
      sidebarCollapsed: true,
    });
    expect(collapsed.sidebarWidth).toBe(COLLAPSED_SIDEBAR_WIDTH);
    expect(collapsed.inspectorWidth).toBe(480);

    const closed = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 900,
      sidebarWidth: 512,
      inspectorWidth: 480,
      inspectorOpen: false,
    });
    expect(closed.sidebarWidth).toBe(512);
    expect(closed.inspectorWidth).toBe(0);
  });

  it("preserves wide viewport preferences", () => {
    expect(resolveDesktopPanelWidths({
      ...defaults,
      sidebarWidth: 416,
      inspectorWidth: 256,
    })).toMatchObject({ sidebarWidth: 416, inspectorWidth: 256 });
  });

  it("yields inspector, then sidebar, then browser pane when the pane joins the budget", () => {
    // 1440 − 360 fixed = 1080 of variable room against 272 + 304 + 560 = 1136:
    // the inspector alone absorbs the 56 overflow.
    const inspectorOnly = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1440,
      browserPaneOpen: true,
    });
    expect(inspectorOnly).toMatchObject({
      sidebarWidth: 272,
      inspectorWidth: 304 - 56,
      browserPaneWidth: 560,
      browserPaneFits: true,
    });

    // 1380 → 1020 of room: the inspector bottoms out at 224 (80 given) and
    // the sidebar gives the remaining 36; the pane keeps its preference.
    const thenSidebar = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1380,
      browserPaneOpen: true,
    });
    expect(thenSidebar).toMatchObject({
      sidebarWidth: 272 - 36,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      browserPaneWidth: 560,
      browserPaneFits: true,
    });

    // 1200 → 840 of room: both chrome panes at minimum leaves 392 for the pane.
    const thenPane = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1200,
      browserPaneOpen: true,
    });
    expect(thenPane).toMatchObject({
      sidebarWidth: SIDEBAR_MIN_WIDTH,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      browserPaneWidth: 392,
      browserPaneAllowedMax: 392,
      browserPaneFits: true,
    });
  });

  it("reports the pane does not fit at 900px with the sidebar expanded and inspector open", () => {
    const resolved = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 900,
      browserPaneOpen: true,
    });
    expect(resolved.browserPaneFits).toBe(false);
    expect(resolved.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(resolved.inspectorWidth).toBe(INSPECTOR_MIN_WIDTH);
    // Collapsing the sidebar and closing the inspector frees enough room.
    expect(resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 900,
      browserPaneOpen: true,
      sidebarCollapsed: true,
      inspectorOpen: false,
    })).toMatchObject({ browserPaneWidth: 484, browserPaneFits: true });
  });

  it("never reports an allowed maximum below a pane's minimum", () => {
    const resolved = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 400,
      browserPaneOpen: true,
    });
    expect(resolved.sidebarAllowedMax).toBe(SIDEBAR_MIN_WIDTH);
    expect(resolved.inspectorAllowedMax).toBe(INSPECTOR_MIN_WIDTH);
    expect(resolved.browserPaneAllowedMax).toBe(BROWSER_PANE_MIN_WIDTH);
    expect(resolved.browserPaneFits).toBe(false);
  });
});
