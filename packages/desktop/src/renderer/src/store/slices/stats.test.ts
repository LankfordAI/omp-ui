import { describe, expect, it } from "vitest";
import type { StatsQuery } from "@omp-ui/core/types";
import { h } from "../../test/store-harness";
import { focusOn } from "./view";

const ALL: StatsQuery = { rangeDays: null, projectKey: null, provider: null, model: null, agentType: null };
const FILTERED: StatsQuery = {
  rangeDays: 7,
  projectKey: "project:/work/app",
  provider: "anthropic",
  model: { provider: "anthropic", id: "claude" },
  agentType: "task",
};

describe("Stats view slice", () => {
  it("starts closed and defaults every filter to all", () => {
    expect(h.useStore.getState().stats).toBeNull();
    h.useStore.getState().openStats();
    expect(h.useStore.getState().stats).toEqual(ALL);
  });

  it("opens and replaces the whole query without retaining old filters", () => {
    h.useStore.getState().openStats(FILTERED);
    expect(h.useStore.getState().stats).toEqual(FILTERED);
    h.useStore.getState().setStatsQuery({ ...ALL, rangeDays: 30 });
    expect(h.useStore.getState().stats).toEqual({ ...ALL, rangeDays: 30 });
    h.useStore.getState().closeStats();
    h.useStore.getState().setStatsQuery(FILTERED);
    expect(h.useStore.getState().stats).toBeNull();
    h.useStore.getState().openStats();
    expect(h.useStore.getState().stats).toEqual(ALL);
  });

  it("copies caller-owned paired model selections", () => {
    const query: StatsQuery = { ...FILTERED, model: { provider: "anthropic", id: "original" } };
    h.useStore.getState().openStats(query);
    query.model!.id = "mutated";
    expect(h.useStore.getState().stats?.model?.id).toBe("original");
    h.useStore.getState().setStatsQuery(query);
    query.model!.id = "changed again";
    expect(h.useStore.getState().stats?.model?.id).toBe("mutated");
  });

  it("closes Fleet and its terminal when taking the main pane", () => {
    h.useStore.setState({ fleet: { machines: null, audit: null, updateAll: null, loading: false, error: null } });
    h.useStore.getState().openStats();
    expect(h.useStore.getState().fleet).toBeNull();
    expect(h.useStore.getState().fleetTerminal).toBeNull();
  });

  it("focusOn closes Stats like the other main-pane surfaces", () => {
    expect(focusOn(h.TAB)).toEqual({ activeTabId: h.TAB, lab: null, stats: null, fleet: null, fleetTerminal: null, artifacts: null });
  });
});
