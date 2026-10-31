import { describe, expect, it } from "vitest";
import {
  BROWSER_PANE_DEFAULT_WIDTH,
  BROWSER_PANE_MAX_WIDTH,
  BROWSER_PANE_MIN_WIDTH,
  DEVICE_PANE_DEFAULT_WIDTH,
  DEVICE_PANE_MAX_WIDTH,
  DEVICE_PANE_MIN_WIDTH,
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

/** Every pane at its default preference with the split column empty. */
const defaults: DesktopPanelWidthsInput = {
  viewportWidth: 1200,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  inspectorOpen: true,
  split: null,
};

const browserSplit = { kind: "browserPane", width: BROWSER_PANE_DEFAULT_WIDTH } as const;

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
    expect(clampPanelWidth("devicePane", 1)).toBe(DEVICE_PANE_MIN_WIDTH);
    expect(clampPanelWidth("devicePane", 9999)).toBe(DEVICE_PANE_MAX_WIDTH);
    expect(clampPanelWidth("devicePane", Number.NaN)).toBe(DEVICE_PANE_DEFAULT_WIDTH);
  });

  it("reduces the inspector first when the 900px desktop budget is exceeded", () => {
    // 900 − 380 fixed = 520 of room against 312 + 304 = 616: the inspector
    // bottoms out at 224 (80 given) and the sidebar gives the remaining 16.
    expect(resolveDesktopPanelWidths({ ...defaults, viewportWidth: 900 })).toEqual({
      sidebarWidth: 296,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      splitWidth: 0,
      sidebarAllowedMax: 296,
      inspectorAllowedMax: INSPECTOR_MIN_WIDTH,
      splitAllowedMax: BROWSER_PANE_MAX_WIDTH,
      splitFits: true,
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

  it("yields inspector, then sidebar, then the split pane when it joins the budget", () => {
    // 1500 − 380 fixed = 1120 of variable room against 312 + 304 + 560 = 1176:
    // the inspector alone absorbs the 56 overflow.
    const inspectorOnly = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1500,
      split: browserSplit,
    });
    expect(inspectorOnly).toMatchObject({
      sidebarWidth: 312,
      inspectorWidth: 304 - 56,
      splitWidth: 560,
      splitFits: true,
    });

    // 1440 → 1060 of room, 116 overflow: the inspector bottoms out at 224 (80
    // given) and the sidebar gives the remaining 36; the pane keeps its preference.
    const thenSidebar = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1440,
      split: browserSplit,
    });
    expect(thenSidebar).toMatchObject({
      sidebarWidth: 312 - 36,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      splitWidth: 560,
      splitFits: true,
    });

    // 1200 → 820 of room: both chrome panes at minimum leaves 372 for the pane.
    const thenPane = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 1200,
      split: browserSplit,
    });
    expect(thenPane).toMatchObject({
      sidebarWidth: SIDEBAR_MIN_WIDTH,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      splitWidth: 372,
      splitAllowedMax: 372,
      splitFits: true,
    });
  });

  it("gives the chrome panes their room back when the pane falls back to the column posture", () => {
    // 900 → 520 of room: sidebar 312 + inspector 304 = 616 already overflows,
    // so no split can fit; the pane is not rendered and must not shrink them.
    const resolved = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 900,
      split: browserSplit,
    });
    expect(resolved).toEqual({
      ...resolveDesktopPanelWidths({ ...defaults, viewportWidth: 900, split: null }),
      splitFits: false,
    });
    // 1100 → 720 of room: the pair fits at preference (616) but leaves 104 for
    // the pane, under its 360 minimum; neither chrome pane yields for it.
    expect(resolveDesktopPanelWidths({ ...defaults, viewportWidth: 1100, split: browserSplit }))
      .toMatchObject({ sidebarWidth: 312, inspectorWidth: 304, splitFits: false });
    // Collapsing the sidebar and closing the inspector frees enough room: the
    // collapsed sidebar takes no width, so the pane gets 900 − 380 = 520.
    expect(resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 900,
      split: browserSplit,
      sidebarCollapsed: true,
      inspectorOpen: false,
    })).toMatchObject({ sidebarWidth: 0, splitWidth: 520, splitFits: true });
  });

  it("never reports an allowed maximum below a pane's minimum", () => {
    const resolved = resolveDesktopPanelWidths({
      ...defaults,
      viewportWidth: 400,
      split: browserSplit,
    });
    expect(resolved.sidebarAllowedMax).toBe(SIDEBAR_MIN_WIDTH);
    expect(resolved.inspectorAllowedMax).toBe(INSPECTOR_MIN_WIDTH);
    expect(resolved.splitAllowedMax).toBeGreaterThanOrEqual(BROWSER_PANE_MIN_WIDTH);
    expect(resolved.splitFits).toBe(false);
  });

  it("budgets a device pane against its own bounds", () => {
    const deviceSplit = { kind: "devicePane", width: DEVICE_PANE_DEFAULT_WIDTH } as const;
    // 1200 → 820 of room: both chrome panes at minimum leave 372, enough for
    // the device pane's 300 minimum.
    expect(resolveDesktopPanelWidths({ ...defaults, viewportWidth: 1200, split: deviceSplit })).toMatchObject({
      sidebarWidth: SIDEBAR_MIN_WIDTH,
      inspectorWidth: INSPECTOR_MIN_WIDTH,
      splitWidth: 372,
      splitAllowedMax: 372,
      splitFits: true,
    });
    // 1100 → 720 of room, 272 after both chrome minimums: under 300, so the
    // device pane falls back to the column and the chrome keeps its room.
    expect(resolveDesktopPanelWidths({ ...defaults, viewportWidth: 1100, split: deviceSplit })).toEqual({
      ...resolveDesktopPanelWidths({ ...defaults, viewportWidth: 1100, split: null }),
      splitFits: false,
    });
  });
});
