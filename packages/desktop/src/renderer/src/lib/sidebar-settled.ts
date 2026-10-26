import { setSidebarSectionOpen, useSidebarSectionOpen } from "./sidebar-section-open";

/** Kept as its own module: the persisted key and existing call sites survive
 *  the generalization to every sidebar section (issue #935). */
const KEY = "omp-ui.sidebarSettledOpen";

export function useSettledOpen(): boolean {
  return useSidebarSectionOpen(KEY, false);
}

export function setSettledOpen(next: boolean): void {
  setSidebarSectionOpen(KEY, next);
}
