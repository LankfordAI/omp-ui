// Routines, renderer side (ADR-0100, issue #1261): the host's routines:state
// snapshot and the full-pane Routines view's open flag. The channels are
// host-local — a joined instance never answers them — so every request rides
// the local backend, and requests that the view shows inline (save refusals,
// the Run now busy refusal, Dry run, the tool catalog) reject to the caller
// instead of landing in the error notices.
import type {
  RoutineCatalogSnapshot,
  RoutineDryRunRequest,
  RoutineDryRunResult,
  RoutineInput,
  RoutinePatch,
  RoutineRecord,
  RoutinesState,
} from "@omp-ui/core/routine";
import { backend } from "../../backend";
import type { GetState, SetState } from "./shared";
import { bumpNavigationGeneration } from "./view";

export interface RoutinesSlice {
  /** The last routines:state snapshot; null until the first read lands. */
  routinesState: RoutinesState | null;
  /** The full-pane Routines view is showing (closed by any tab activation, like Stats). */
  routinesOpen: boolean;
  openRoutines(): void;
  closeRoutines(): void;
  replaceRoutines(state: RoutinesState): void;
  refreshRoutines(): Promise<void>;
  createRoutine(input: RoutineInput): Promise<RoutineRecord>;
  updateRoutine(id: string, patch: RoutinePatch): Promise<RoutineRecord>;
  removeRoutine(id: string): Promise<{ releasedSessions: number }>;
  /** Rejects with main's inline refusal (busy lane, gate off) verbatim. */
  runRoutineNow(id: string): Promise<{ tabId: string; runId: string }>;
  dryRunRoutine(req: RoutineDryRunRequest): Promise<RoutineDryRunResult>;
  loadRoutineToolCatalog(projectCwd: string): Promise<RoutineCatalogSnapshot>;
}

export function createRoutinesSlice(set: SetState, get: GetState): RoutinesSlice {
  return {
    routinesState: null,
    routinesOpen: false,
    openRoutines() {
      if (get().state?.routinesEnabled !== true) return;
      bumpNavigationGeneration();
      if (get().lab !== null) get().closeLab();
      set({ routinesOpen: true, artifacts: null, stats: null, fleet: null, fleetTerminal: null, compactSurface: null });
      void get().refreshRoutines();
    },
    closeRoutines() {
      bumpNavigationGeneration();
      set({ routinesOpen: false });
    },
    replaceRoutines(routinesState) {
      set({ routinesState });
    },
    async refreshRoutines() {
      try {
        set({ routinesState: await backend.getRoutinesState() });
      } catch (err) {
        get().reportError(err);
      }
    },
    createRoutine: (input) => backend.createRoutine(input),
    updateRoutine: (id, patch) => backend.updateRoutine(id, patch),
    removeRoutine: (id) => backend.removeRoutine(id),
    runRoutineNow: (id) => backend.runRoutineNow(id),
    dryRunRoutine: (req) => backend.dryRunRoutine(req),
    loadRoutineToolCatalog: (projectCwd) => backend.listRoutineToolCatalog(projectCwd),
  };
}
