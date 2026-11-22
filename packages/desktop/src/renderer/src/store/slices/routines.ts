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
  /** A transcript review link asked the view to focus this routine id; cleared once picked. */
  routineFocusId: string | null;
  openRoutines(): void;
  closeRoutines(): void;
  /** Opens the view and asks it to select one routine (omp-ui://routine review link). */
  focusRoutine(id: string): void;
  /** The view consumed the focus request. */
  clearRoutineFocus(): void;
  replaceRoutines(state: RoutinesState): void;
  refreshRoutines(): Promise<void>;
  createRoutine(input: RoutineInput): Promise<RoutineRecord>;
  updateRoutine(id: string, patch: RoutinePatch): Promise<RoutineRecord>;
  removeRoutine(id: string): Promise<{ releasedSessions: number }>;
  /** Rejects with main's inline refusal (busy lane, gate off) verbatim. */
  runRoutineNow(id: string): Promise<{ tabId: string; runId: string }>;
  dryRunRoutine(req: RoutineDryRunRequest): Promise<RoutineDryRunResult>;
  loadRoutineToolCatalog(projectCwd: string): Promise<RoutineCatalogSnapshot>;
  /** Appends one tool key to the routine's allow list; refuses a routine the
   *  host no longer has. Used by the ApprovalCard's Always allow (#1276). */
  grantRoutineTool(routineId: string, toolKey: string): Promise<RoutineRecord>;
}

export function createRoutinesSlice(set: SetState, get: GetState): RoutinesSlice {
  return {
    routinesState: null,
    routinesOpen: false,
    routineFocusId: null,
    openRoutines() {
      if (get().state?.routinesEnabled !== true) return;
      bumpNavigationGeneration();
      if (get().lab !== null) get().closeLab();
      set({ routinesOpen: true, artifacts: null, stats: null, fleet: null, fleetTerminal: null, compactSurface: null });
      void get().refreshRoutines();
    },
    focusRoutine(id) {
      if (get().state?.routinesEnabled !== true) return;
      // openRoutines() is the same navigation; set the focus id after it so a
      // gate-off open leaves no stale request behind.
      get().openRoutines();
      if (get().routinesOpen) set({ routineFocusId: id });
    },
    clearRoutineFocus() {
      set({ routineFocusId: null });
    },
    closeRoutines() {
      bumpNavigationGeneration();
      set({ routinesOpen: false, routineFocusId: null });
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
    async grantRoutineTool(routineId, toolKey) {
      // The renderer only holds a routines:state snapshot when the Routines
      // view has opened or a broadcast landed; during an ordinary run it can
      // be null, so re-read once before refusing (#1276).
      let record = get().routinesState?.routines.find((r) => r.id === routineId) ?? null;
      if (record === null) {
        set({ routinesState: await backend.getRoutinesState() });
        record = get().routinesState?.routines.find((r) => r.id === routineId) ?? null;
      }
      if (record === null) throw new Error(`unknown routine ${routineId}`);
      const current = record.toolPolicy;
      // RoutineService.update restamps lastReviewedAt/reviewedCatalog against
      // the live catalog itself, so the stale values sent here are fine;
      // dropping the key from deny avoids the both-lists refusal.
      return backend.updateRoutine(routineId, {
        toolPolicy: {
          allow: current.allow.includes(toolKey) ? current.allow : [...current.allow, toolKey],
          deny: current.deny.filter((d) => d !== toolKey),
          lastReviewedAt: current.lastReviewedAt,
          reviewedCatalog: current.reviewedCatalog,
        },
      });
    },
  };
}
