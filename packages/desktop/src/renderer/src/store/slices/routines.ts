// Routines, renderer side (ADR-0100, amended §8, issues #1261, #1306): local
// and joined-remote routines:state snapshots plus the full-pane Routines view's
// open flag and active host selector. Local requests ride `backend`; remote
// requests ride `backendFor(instanceId)` through `remote-instance:request`.
// Inline failures (save refusals, Run now busy refusal, Dry run, tool catalog)
// reject to the caller instead of landing in the global error notices.
import type {
  RoutineCatalogSnapshot,
  RoutineDryRunRequest,
  RoutineDryRunResult,
  RoutineInput,
  RoutinePatch,
  RoutineRecord,
  RoutineTestScriptRequest,
  RoutineTestScriptResult,
  RoutinesState,
} from "@omp-ui/core/routine";
import type { BackendState } from "@omp-ui/core/types";
import { backend, backendFor, displayMessage } from "../../backend";
import type { GetState, SetState } from "./shared";
import { bumpNavigationGeneration } from "./view";

/** True when this computer or at least one joined remote instance has Routines enabled. */
export function hasAnyRoutinesHost(state: BackendState | null): boolean {
  if (state === null) return false;
  if (state.routinesEnabled === true) return true;
  return state.remoteInstances.some((i) => i.status !== "self" && i.routinesEnabled === true);
}

function defaultRoutinesHost(state: BackendState | null): string | null {
  if (state === null || state.routinesEnabled === true) return null;
  const joined = state.remoteInstances.find(
    (i) => i.status === "joined" && i.routinesEnabled === true,
  );
  if (joined !== undefined) return joined.id;
  const anyEnabled = state.remoteInstances.find(
    (i) => i.status !== "self" && i.routinesEnabled === true,
  );
  return anyEnabled?.id ?? null;
}

export interface RoutinesSlice {
  /** The last local routines:state snapshot; null until the first read lands. */
  routinesState: RoutinesState | null;
  /** The full-pane Routines view is showing (closed by any tab activation, like Stats). */
  routinesOpen: boolean;
  /** Active host in the Routines view; null = this computer. */
  routinesInstanceId: string | null;
  /** Latest routines:state snapshot per joined remote instance. */
  routinesByInstance: Record<string, RoutinesState>;
  /** Last load failure per remote instance (e.g. offline, unknown channel). */
  routinesLoadError: Record<string, string | null>;
  /** In-flight refresh flag per remote instance. */
  routinesLoading: Record<string, boolean>;
  /** A transcript review link asked the view to focus this routine id; cleared once picked. */
  routineFocusId: string | null;
  openRoutines(instanceId?: string | null): void;
  selectRoutinesHost(instanceId: string | null): void;
  closeRoutines(): void;
  /** Opens the view and asks it to select one routine (omp-ui://routine review link). */
  focusRoutine(id: string, instanceId?: string | null): void;
  /** The view consumed the focus request. */
  clearRoutineFocus(): void;
  replaceRoutines(state: RoutinesState): void;
  replaceRemoteRoutines(instanceId: string, state: RoutinesState): void;
  reconcileRoutinesInstances(state: BackendState): void;
  refreshRoutines(instanceId?: string | null): Promise<void>;
  createRoutine(input: RoutineInput, instanceId?: string | null): Promise<RoutineRecord>;
  updateRoutine(id: string, patch: RoutinePatch, instanceId?: string | null): Promise<RoutineRecord>;
  removeRoutine(id: string, instanceId?: string | null): Promise<{ releasedSessions: number }>;
  /** Rejects with main's inline refusal (busy lane, gate off) verbatim. */
  runRoutineNow(id: string, instanceId?: string | null): Promise<{ tabId: string; runId: string }>;
  dryRunRoutine(req: RoutineDryRunRequest, instanceId?: string | null): Promise<RoutineDryRunResult>;
  /** Attended "Test script" editor action (#1283); nothing is persisted. */
  testRoutineScript(
    input: RoutineTestScriptRequest,
    instanceId?: string | null,
  ): Promise<RoutineTestScriptResult>;
  loadRoutineToolCatalog(
    projectCwd: string,
    instanceId?: string | null,
  ): Promise<RoutineCatalogSnapshot>;
  /** Appends one tool key to the routine's allow list; refuses a routine the
   *  host no longer has. Used by the ApprovalCard's Always allow (#1276, #1306). */
  grantRoutineTool(
    routineId: string,
    toolKey: string,
    instanceId?: string | null,
  ): Promise<RoutineRecord>;
}

function dropMissingKeys<T>(record: Record<string, T>, validIds: ReadonlySet<string>): Record<string, T> | null {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (validIds.has(key)) next[key] = value;
    else changed = true;
  }
  return changed ? next : null;
}

export function createRoutinesSlice(set: SetState, get: GetState): RoutinesSlice {
  return {
    routinesState: null,
    routinesOpen: false,
    routinesInstanceId: null,
    routinesByInstance: {},
    routinesLoadError: {},
    routinesLoading: {},
    routineFocusId: null,
    openRoutines(instanceId) {
      const state = get().state;
      if (!hasAnyRoutinesHost(state)) return;
      const validRemote = (id: string): boolean =>
        state?.remoteInstances.some((i) => i.id === id && i.status !== "self") === true;
      let target: string | null;
      if (instanceId !== undefined) {
        if (instanceId !== null && !validRemote(instanceId)) return;
        target = instanceId;
      } else {
        const current = get().routinesInstanceId;
        if (current !== null && validRemote(current)) {
          target = current;
        } else {
          target = defaultRoutinesHost(state);
        }
      }
      bumpNavigationGeneration();
      if (get().lab !== null) get().closeLab();
      set({
        routinesOpen: true,
        routinesInstanceId: target,
        artifacts: null,
        stats: null,
        fleet: null,
        fleetTerminal: null,
        compactSurface: null,
      });
      void get().refreshRoutines(target);
      // Prefetch other enabled hosts in the background so dropdown counts/badges populate.
      if (target !== null && state?.routinesEnabled === true) {
        void get().refreshRoutines(null);
      }
      for (const inst of state?.remoteInstances ?? []) {
        if (inst.id === target || inst.status !== "joined" || inst.routinesEnabled !== true) continue;
        void get().refreshRoutines(inst.id);
      }
    },
    selectRoutinesHost(instanceId) {
      set({ routinesInstanceId: instanceId, routineFocusId: null });
      void get().refreshRoutines(instanceId);
    },
    focusRoutine(id, instanceId) {
      if (!hasAnyRoutinesHost(get().state)) return;
      // openRoutines() is the same navigation; set the focus id after it so a
      // gate-off open leaves no stale request behind.
      get().openRoutines(instanceId === undefined ? null : instanceId);
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
    replaceRemoteRoutines(instanceId, state) {
      set((s) => ({
        routinesByInstance: { ...s.routinesByInstance, [instanceId]: state },
        routinesLoadError: { ...s.routinesLoadError, [instanceId]: null },
      }));
    },
    reconcileRoutinesInstances(state) {
      const validIds = new Set(
        state.remoteInstances.filter((i) => i.status !== "self").map((i) => i.id),
      );
      set((s) => {
        const nextByInstance = dropMissingKeys(s.routinesByInstance, validIds);
        const nextErrors = dropMissingKeys(s.routinesLoadError, validIds);
        const nextLoading = dropMissingKeys(s.routinesLoading, validIds);
        const activeRemoved = s.routinesInstanceId !== null && !validIds.has(s.routinesInstanceId);
        const anyHost = hasAnyRoutinesHost(state);
        if (
          nextByInstance === null &&
          nextErrors === null &&
          nextLoading === null &&
          !activeRemoved &&
          (!s.routinesOpen || anyHost)
        ) {
          return {};
        }
        const patch: Partial<RoutinesSlice> = {};
        if (nextByInstance !== null) patch.routinesByInstance = nextByInstance;
        if (nextErrors !== null) patch.routinesLoadError = nextErrors;
        if (nextLoading !== null) patch.routinesLoading = nextLoading;
        if (!anyHost) {
          if (s.routinesOpen) patch.routinesOpen = false;
          if (s.routineFocusId !== null) patch.routineFocusId = null;
          if (activeRemoved) patch.routinesInstanceId = null;
        } else if (activeRemoved) {
          patch.routinesInstanceId = defaultRoutinesHost(state);
          patch.routineFocusId = null;
        }
        return patch;
      });
    },
    async refreshRoutines(instanceId = get().routinesInstanceId) {
      if (instanceId === null) {
        try {
          set({ routinesState: await backend.getRoutinesState() });
        } catch (err) {
          get().reportError(err);
        }
        return;
      }
      set((s) => ({
        routinesLoading: { ...s.routinesLoading, [instanceId]: true },
      }));
      try {
        const next = await backendFor(instanceId).getRoutinesState();
        set((s) => ({
          routinesByInstance: { ...s.routinesByInstance, [instanceId]: next },
          routinesLoadError: { ...s.routinesLoadError, [instanceId]: null },
          routinesLoading: { ...s.routinesLoading, [instanceId]: false },
        }));
      } catch (err) {
        set((s) => ({
          routinesLoadError: { ...s.routinesLoadError, [instanceId]: displayMessage(err) },
          routinesLoading: { ...s.routinesLoading, [instanceId]: false },
        }));
      }
    },
    createRoutine: (input, instanceId = get().routinesInstanceId) =>
      backendFor(instanceId).createRoutine(input),
    updateRoutine: (id, patch, instanceId = get().routinesInstanceId) =>
      backendFor(instanceId).updateRoutine(id, patch),
    removeRoutine: (id, instanceId = get().routinesInstanceId) =>
      backendFor(instanceId).removeRoutine(id),
    runRoutineNow: (id, instanceId = get().routinesInstanceId) =>
      backendFor(instanceId).runRoutineNow(id),
    dryRunRoutine: (req, instanceId = get().routinesInstanceId) =>
      backendFor(instanceId).dryRunRoutine(req),
    testRoutineScript: (input, instanceId = get().routinesInstanceId) =>
      backendFor(instanceId).testRoutineScript(input),
    loadRoutineToolCatalog: (projectCwd, instanceId = get().routinesInstanceId) =>
      backendFor(instanceId).listRoutineToolCatalog(projectCwd),
    async grantRoutineTool(routineId, toolKey, instanceId = null) {
      const target = instanceId ?? null;
      // The renderer only holds a routines:state snapshot when the Routines
      // view has opened or a broadcast landed; during an ordinary run it can
      // be null, so re-read once before refusing (#1276, #1306).
      const readCurrent = (): RoutinesState | null =>
        target === null ? get().routinesState : (get().routinesByInstance[target] ?? null);
      let record = readCurrent()?.routines.find((r) => r.id === routineId) ?? null;
      if (record === null) {
        const fresh = await backendFor(target).getRoutinesState();
        if (target === null) {
          set({ routinesState: fresh });
        } else {
          set((s) => ({
            routinesByInstance: { ...s.routinesByInstance, [target]: fresh },
            routinesLoadError: { ...s.routinesLoadError, [target]: null },
          }));
        }
        record = fresh.routines.find((r) => r.id === routineId) ?? null;
      }
      if (record === null) throw new Error(`unknown routine ${routineId}`);
      const current = record.toolPolicy;
      // RoutineService.update restamps lastReviewedAt/reviewedCatalog against
      // the live catalog itself, so the stale values sent here are fine;
      // dropping the key from deny avoids the both-lists refusal.
      return backendFor(target).updateRoutine(routineId, {
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
