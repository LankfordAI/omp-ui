// Stats slice tests (issue #668): the Stats view's open/set-range/close
// transitions, and focusOn's coordination with it.
import { describe, expect, it } from "vitest";
import { h } from "../../test/store-harness";
import { focusOn } from "./view";

describe("Stats view slice", () => {
  it("opens closed", () => {
    expect(h.useStore.getState().stats).toBeNull();
  });

  it("openStats opens with all time by default and an explicit range", () => {
    h.useStore.getState().openStats();
    expect(h.useStore.getState().stats).toEqual({ rangeDays: null });
    h.useStore.getState().openStats(30);
    expect(h.useStore.getState().stats).toEqual({ rangeDays: 30 });
  });

  it("setStatsRange only mutates an open surface", () => {
    h.useStore.getState().setStatsRange(7);
    expect(h.useStore.getState().stats).toBeNull();
    h.useStore.getState().openStats(30);
    h.useStore.getState().setStatsRange(7);
    expect(h.useStore.getState().stats).toEqual({ rangeDays: 7 });
    h.useStore.getState().setStatsRange(null);
    expect(h.useStore.getState().stats).toEqual({ rangeDays: null });
  });

  it("closeStats closes", () => {
    h.useStore.getState().openStats(7);
    h.useStore.getState().closeStats();
    expect(h.useStore.getState().stats).toBeNull();
  });

  it("focusOn closes the Stats view like the Lab", () => {
    expect(focusOn({ activeTabId: null, focusedTabByProject: {} }, h.TAB, "/p")).toEqual({
      activeTabId: h.TAB,
      focusedTabByProject: { "/p": h.TAB },
      lab: null,
      stats: null,
    });
  });
});
