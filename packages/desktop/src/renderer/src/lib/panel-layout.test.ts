import { describe, expect, it } from "vitest";
import {
  BROWSER_PANE_DEFAULT_WIDTH,
  BROWSER_PANE_MAX_WIDTH,
  BROWSER_PANE_MIN_WIDTH,
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
    // 900 − 380 fixed = 520 of room against 312 + 304 = 616: the inspector
    // bottoms out at 224 (80 given) and the sidebar gives the remaining 16.
    expect(resolveDesktopPanelWidths({ ...defaults, viewportWidth: 900 })).toEqual({
      sidebarWidth: 296,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      browserPaneWidth: 0,
      sidebarAllowedMax: 296,
      inspectorAllowedMax: INSPECTOR_MIN_WIDTH,
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
    expect(collapsed.sidebarWidth).toBe(0);
    expect(collapsed.inspectorWidth).toBe(480);

    // A collapsed sidebar adds nothing to the fixed budget: 820 − 380 fixed
    // leaves the inspector all 440px.
    const collapsedNarrow = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 820,
      inspectorWidth: 480,
      sidebarCollapsed: true,
    });
    expect(collapsedNarrow).toMatchObject({ sidebarWidth: 0, inspectorWidth: 440, inspectorAllowedMax: 440 });

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
    // 1500 − 380 fixed = 1120 of variable room against 312 + 304 + 560 = 1176:
    // the inspector alone absorbs the 56 overflow.
    const inspectorOnly = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1500,
      browserPaneOpen: true,
    });
    expect(inspectorOnly).toMatchObject({
      sidebarWidth: 312,
      inspectorWidth: 304 - 56,
      browserPaneWidth: 560,
      browserPaneFits: true,
    });

    // 1440 → 1060 of room, 116 overflow: the inspector bottoms out at 224 (80
    // given) and the sidebar gives the remaining 36; the pane keeps its preference.
    const thenSidebar = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1440,
      browserPaneOpen: true,
    });
    expect(thenSidebar).toMatchObject({
      sidebarWidth: 312 - 36,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      browserPaneWidth: 560,
      browserPaneFits: true,
    });

    // 1200 → 820 of room: both chrome panes at minimum leaves 372 for the pane.
    const thenPane = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1200,
      browserPaneOpen: true,
    });
    expect(thenPane).toMatchObject({
      sidebarWidth: SIDEBAR_MIN_WIDTH,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      browserPaneWidth: 372,
      browserPaneAllowedMax: 372,
      browserPaneFits: true,
    });
  });

  it("gives the chrome panes their room back when the pane falls back to the column posture", () => {
    // 900 → 520 of room: sidebar 312 + inspector 304 = 616 already overflows,
    // so no split can fit; the pane is not rendered and must not shrink them.
    const resolved = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 900,
      browserPaneOpen: true,
    });
    expect(resolved).toEqual({
      ...resolveDesktopPanelWidths({ ...defaults, viewportWidth: 900, browserPaneOpen: false }),
      browserPaneFits: false,
    });
    // 1100 → 720 of room: the pair fits at preference (616) but leaves 104 for
    // the pane, under its 360 minimum; neither chrome pane yields for it.
    expect(resolveDesktopPanelWidths({ ...defaults, viewportWidth: 1100, browserPaneOpen: true }))
      .toMatchObject({ sidebarWidth: 312, inspectorWidth: 304, browserPaneFits: false });
    // Collapsing the sidebar and closing the inspector frees enough room: the
    // collapsed sidebar takes no width, so the pane gets 900 − 380 = 520.
    expect(resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 900,
      browserPaneOpen: true,
      sidebarCollapsed: true,
      inspectorOpen: false,
    })).toMatchObject({ sidebarWidth: 0, browserPaneWidth: 520, browserPaneFits: true });
  });

  it("never reports an allowed maximum below a pane's minimum", () => {
    const resolved = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 400,
      browserPaneOpen: true,
    });
    expect(resolved.sidebarAllowedMax).toBe(SIDEBAR_MIN_WIDTH);
    expect(resolved.inspectorAllowedMax).toBe(INSPECTOR_MIN_WIDTH);
    expect(resolved.browserPaneAllowedMax).toBeGreaterThanOrEqual(BROWSER_PANE_MIN_WIDTH);
    expect(resolved.browserPaneFits).toBe(false);
  });
});
