// Stats view domain (issue #668, ADR-0037): the global cross-session usage
// surface's view state. The data itself is a single `statsOverview` read done
// by the surface — no cache and no refresh timer here: the Lab keeps a timer
// because its source is a live loop, while stats.db advances through omp's
// ingest, so a manual refresh is enough.
import type { GetState, SetState } from "./shared";
import type { StatsSlice } from "../types";

export function createStatsSlice(set: SetState, get: GetState): StatsSlice {
  const openStats: StatsSlice["openStats"] = (rangeDays = null) => {
    set({ stats: { rangeDays } });
  };
  const setStatsRange: StatsSlice["setStatsRange"] = (rangeDays) => {
    const stats = get().stats;
    if (stats !== null) set({ stats: { ...stats, rangeDays } });
  };
  const closeStats = (): void => set({ stats: null });
  return { stats: null, openStats, setStatsRange, closeStats };
}
