// Selection only: the mounted Stats surface owns reads and collector observation.
import type { GetState, SetState } from "./shared";
import type { StatsSlice } from "../types";
import { bumpNavigationGeneration } from "./view";

export function createStatsSlice(set: SetState, get: GetState): StatsSlice {
  const openStats: StatsSlice["openStats"] = (query = {
    rangeDays: null,
    projectKey: null,
    provider: null,
    model: null,
    agentType: null,
  }) => {
    bumpNavigationGeneration();
    if (get().lab !== null) get().closeLab();
    set({ stats: { ...query, model: query.model === null ? null : { ...query.model } }, artifacts: null, fleet: null, fleetTerminal: null });
  };
  const setStatsQuery: StatsSlice["setStatsQuery"] = (query) => {
    if (get().stats !== null) {
      set({ stats: { ...query, model: query.model === null ? null : { ...query.model } } });
    }
  };
  const closeStats = (): void => { bumpNavigationGeneration(); set({ stats: null }); };
  return { stats: null, openStats, setStatsQuery, closeStats };
}
