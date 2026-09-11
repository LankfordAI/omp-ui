import type {
  BackendState,
  OwnedSessionRecord,
  RemoteInstanceSummary,
  SessionSummary,
} from "@omp-ui/core/types";
import type { CapabilitySectionId } from "@omp-ui/core/capabilities";
import type { StateCreator, StoreApi } from "zustand";
import { backend } from "../../backend";
import {
  desktopViewStorage,
  loadDesktopView,
  projectDesktopView,
  saveDesktopView,
  shouldRestoreDesktopView,
  type DesktopViewStateV1,
} from "../../lib/desktop-view-state";
import {
  clampPanelWidth,
  INSPECTOR_DEFAULT_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from "../../lib/panel-layout";
import { randomId } from "../../lib/random-id";
import { projectKey } from "../../lib/project-key";
import type { CompactSurface, ErrorNotice, UiStore } from "../types";

export type { CompactSurface } from "../types";


export interface ViewSlice {
  tabs: UiStore["tabs"];
  activeTabId: string | null;
  focusedTabByProject: Record<string, string>;
  restoringTabs: boolean;
  projectPickerOpen: boolean;
  projectPickerInstanceId: string | null;
  /** The diagnostic-bundle export dialog (issue #413). */
  diagnosticsDialogOpen: boolean;
  worktreeDialogProject: string | null;
  worktreeDialogInstanceId: string | null;
  /** The tab whose Finish worktree dialog is open (issues #385–#389); null = closed. */
  finishWorktreeTab: string | null;
  capabilitiesViewer: {
    scopeCwd: string | null;
    tabId?: string;
    section: CapabilitySectionId;
    instanceId: string | null;
  } | null;
	projectSettings: { projectCwd: string; instanceId: string | null } | null;
  ptyRedrawRevision: Record<string, number>;
  compactSurface: CompactSurface | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  inspectorOpen: boolean;
  openProjectPicker(instanceId?: string | null): void;
  closeProjectPicker(): void;
  openDiagnosticsDialog(): void;
  closeDiagnosticsDialog(): void;
  openWorktreeDialog(projectCwd: string, instanceId?: string | null): void;
  closeWorktreeDialog(): void;
  openFinishWorktree(tabId: string): void;
  closeFinishWorktree(): void;
  openCapabilitiesViewer(
    scopeCwd: string | null,
    tabId?: string,
    section?: CapabilitySectionId,
    instanceId?: string | null,
  ): void;
  closeCapabilitiesViewer(): void;
	openProjectSettings(projectCwd: string, instanceId?: string | null): void;
	closeProjectSettings(): void;
  showCompactSurface(surface: CompactSurface): void;
  closeCompactSurface(): void;
  toggleSidebarCollapsed(): void;
  setSidebarWidth(width: number): void;
  setInspectorWidth(width: number): void;
  setInspectorOpen(open: boolean): void;
  /**
   * Backend failures awaiting acknowledgment (issue #373): the renderer-side
   * replacement for window.alert. Arrival order is kept; nothing times out,
   * dedupes, or silently replaces an earlier error.
   */
  errorNotices: ErrorNotice[];
  reportError(error: unknown): void;
  dismissError(id: string): void;
}

/**
 * Keeps global and per-project focus in lockstep for every tab activation.
 * `key` is the tab's projectKey(instanceId, projectCwd); undefined when the
 * tab is unknown, in which case only the global focus moves.
 */
export function focusOn(
  state: Pick<UiStore, "activeTabId" | "focusedTabByProject">,
  tabId: string,
  key: string | undefined,
): Pick<UiStore, "activeTabId" | "focusedTabByProject"> {
  return {
    activeTabId: tabId,
    focusedTabByProject:
      key === undefined
        ? state.focusedTabByProject
        : { ...state.focusedTabByProject, [key]: tabId },
  };
}

/** Reassigns or forgets a project's remembered focus when a tab is hidden. */
export function forgetFocus(
  focusedTabByProject: Record<string, string>,
  tabId: string,
  tabs: UiStore["tabs"],
): Record<string, string> {
  const entry = Object.entries(focusedTabByProject).find(([, focused]) => focused === tabId);
  if (entry === undefined) return focusedTabByProject;
  const [key] = entry;
  const remaining = tabs.filter(
    (tab) => !tab.hidden && projectKey(tab.instanceId, tab.projectCwd) === key,
  );
  const next = { ...focusedTabByProject };
  if (remaining.length > 0) next[key] = remaining[remaining.length - 1]!.tabId;
  else delete next[key];
  return next;
}

/**
 * Removes focus entries whose project or tab no longer exists in backend
 * state. Remote projects count under their composite key, so a vanished
 * instance drops every entry it owned (issue #416).
 */
export function pruneFocus(
  focusedTabByProject: Record<string, string>,
  state: BackendState,
): Record<string, string> {
  const projects = new Set<string>();
  const tabIds = new Set<string>();
  const collect = (instanceId: string | null, groups: BackendState["projects"]): void => {
    for (const group of groups) {
      projects.add(projectKey(instanceId, group.project.path));
      for (const session of group.sessions) tabIds.add(session.tabId);
    }
  };
  collect(null, state.projects);
  for (const instance of state.remoteInstances) collect(instance.id, instance.projects);
  const next: Record<string, string> = {};
  let changed = false;
  for (const [key, tabId] of Object.entries(focusedTabByProject)) {
    if (projects.has(key) && tabIds.has(tabId)) next[key] = tabId;
    else changed = true;
  }
  return changed ? next : focusedTabByProject;
}

/** Restores resumable tabs in saved renderer order, then settles saved focus. */
export async function restoreSavedTabs(
  get: StoreApi<UiStore>["getState"],
  set: StoreApi<UiStore>["setState"],
  saved: DesktopViewStateV1,
): Promise<void> {
  const restored: string[] = [];
  for (const tabId of saved.tabIds) {
    const record = findRecord(get().state, tabId);
    if (record === undefined || record.live === "missing") continue;
    await get().openSession(tabId);
    if (get().tabs.some((tab) => tab.tabId === tabId)) restored.push(tabId);
  }

  const restoredSet = new Set(restored);
  const focusedTabByProject: Record<string, string> = {};
  const lastRestoredByProject = new Map<string, string>();
  for (const tabId of restored) {
    const owner = findOwner(get().state, tabId);
    if (owner) {
      lastRestoredByProject.set(projectKey(owner.instanceId, owner.record.projectCwd), tabId);
    }
  }
  for (const [key, tabId] of Object.entries(saved.focusedTabByProject)) {
    if (restoredSet.has(tabId)) focusedTabByProject[key] = tabId;
  }
  for (const [key, tabId] of lastRestoredByProject) {
    if (!(key in focusedTabByProject)) focusedTabByProject[key] = tabId;
  }

  const activeTabId =
    saved.activeTabId !== null && restoredSet.has(saved.activeTabId)
      ? saved.activeTabId
      : (restored.at(-1) ?? null);
  set({ focusedTabByProject, activeTabId });
}

/** Restores the saved view after initialization's combined backend commit. */
export async function restoreDesktopView(api: StoreApi<UiStore>): Promise<void> {
  const storage = desktopViewStorage();
  if (storage === null) return;
  const saved = loadDesktopView(storage);
  const currentVersion = api.getState().appUpdate.currentVersion;
  if (saved !== null) {
    api.setState({
      sidebarWidth: saved.sidebarWidth,
      inspectorWidth: saved.inspectorWidth,
    });
  }
  if (shouldRestoreDesktopView(saved, currentVersion)) {
    api.setState({ restoringTabs: true });
    try {
      await restoreSavedTabs(api.getState, api.setState, saved!);
    } finally {
      api.setState({ restoringTabs: false });
    }
  }
  if (currentVersion !== null) {
    saveDesktopView(storage, projectDesktopView(api.getState(), currentVersion));
  }
}

const persistenceInstalled = new WeakSet<StoreApi<UiStore>>();

/** Installs one view-only persistence subscriber after initial restoration. */
export function installDesktopViewPersistence(api: StoreApi<UiStore>): void {
  if (persistenceInstalled.has(api)) return;
  persistenceInstalled.add(api);
  api.subscribe((state, previous) => {
    if (state.restoringTabs) return;
    if (
      state.tabs === previous.tabs &&
      state.activeTabId === previous.activeTabId &&
      state.focusedTabByProject === previous.focusedTabByProject &&
      state.appUpdate.currentVersion === previous.appUpdate.currentVersion &&
      state.sidebarWidth === previous.sidebarWidth &&
      state.inspectorWidth === previous.inspectorWidth
    ) {
      return;
    }
    const version = state.appUpdate.currentVersion;
    const storage = desktopViewStorage();
    if (storage === null || version === null) return;
    saveDesktopView(storage, projectDesktopView(state, version));
  });
}

/** Storage key for this renderer's stable report identity. */
const VIEWED_CLIENT_ID_KEY = "omp-ui.viewedTab.clientId";
/** Re-report cadence; the backend treats a report as stale after 15 min. */
const VIEWED_HEARTBEAT_MS = 5 * 60_000;

let memoryClientId: string | null = null;

/**
 * This renderer's stable report identity: persisted so a reload replaces (not
 * duplicates) its report on the backend; in-memory when storage is unavailable
 * (jsdom harness, private mode). Same defensive style as desktop-view-state.ts.
 */
function clientId(): string {
  if (memoryClientId !== null) return memoryClientId;
  try {
    const storage = desktopViewStorage();
    if (storage !== null) {
      const existing = storage.getItem(VIEWED_CLIENT_ID_KEY);
      if (existing !== null && existing !== "") {
        memoryClientId = existing;
        return existing;
      }
      const fresh = randomId();
      try {
        storage.setItem(VIEWED_CLIENT_ID_KEY, fresh);
      } catch {
        // Best-effort persist; the in-memory copy still works for this load.
      }
      memoryClientId = fresh;
      return fresh;
    }
  } catch {
    // Fall through to the in-memory id.
  }
  memoryClientId = randomId();
  return memoryClientId;
}

const reporterInstalled = new WeakSet<StoreApi<UiStore>>();

/**
 * Reports this renderer's active tab to the backend so the hibernation guard
 * never kills the tab the user is looking at (issue #266). Mirrors
 * installDesktopViewPersistence: one subscriber per store, installed after
 * restoreDesktopView has settled focus, so the initial report carries the
 * restored activeTabId. Returns the disposer.
 */
export function installViewedTabReporter(api: StoreApi<UiStore>): () => void {
  if (reporterInstalled.has(api)) return () => {};
  reporterInstalled.add(api);
  const report = (): void => {
    backend.tabViewed(clientId(), api.getState().activeTabId);
  };
  report(); // post-restore initial report (restoringTabs settled by then)
  const unsubscribe = api.subscribe((state, previous) => {
    if (state.activeTabId !== previous.activeTabId) report();
  });
  const timer = setInterval(report, VIEWED_HEARTBEAT_MS);
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}

export const createViewSlice: StateCreator<UiStore, [], [], ViewSlice> = (set) => ({
  tabs: [],
  activeTabId: null,
  focusedTabByProject: {},
  restoringTabs: false,
  projectPickerOpen: false,
  projectPickerInstanceId: null,
  diagnosticsDialogOpen: false,
  worktreeDialogProject: null,
  worktreeDialogInstanceId: null,
  finishWorktreeTab: null,
  capabilitiesViewer: null,
	projectSettings: null,
  ptyRedrawRevision: {},
  compactSurface: null,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  inspectorOpen: false,
  errorNotices: [],
  reportError(error) {
    set((s) => ({
      errorNotices: [
        ...s.errorNotices,
        {
          id: randomId(),
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }));
  },
  dismissError(id) {
    set((s) => ({ errorNotices: s.errorNotices.filter((n) => n.id !== id) }));
  },

  openProjectPicker(instanceId = null) {
    set({ projectPickerOpen: true, projectPickerInstanceId: instanceId });
  },
  closeProjectPicker() {
    set({ projectPickerOpen: false, projectPickerInstanceId: null });
  },
  openDiagnosticsDialog() {
    set({ diagnosticsDialogOpen: true });
  },
  closeDiagnosticsDialog() {
    set({ diagnosticsDialogOpen: false });
  },
  openWorktreeDialog(projectCwd, instanceId = null) {
    set({ worktreeDialogProject: projectCwd, worktreeDialogInstanceId: instanceId });
  },
  closeWorktreeDialog() {
    set({ worktreeDialogProject: null, worktreeDialogInstanceId: null });
  },
  openFinishWorktree(tabId) {
    set({ finishWorktreeTab: tabId });
  },
  closeFinishWorktree() {
    set({ finishWorktreeTab: null });
  },
  openCapabilitiesViewer(scopeCwd, tabId, section = "mcp", instanceId = null) {
    set({
      capabilitiesViewer:
        tabId === undefined
          ? { scopeCwd, section, instanceId }
          : { scopeCwd, tabId, section, instanceId },
    });
  },
  closeCapabilitiesViewer() {
    set({ capabilitiesViewer: null });
  },
	openProjectSettings(projectCwd, instanceId = null) {
		set({ projectSettings: { projectCwd, instanceId } });
	},
	closeProjectSettings() {
		set({ projectSettings: null });
	},
  showCompactSurface(surface) {
    set({ compactSurface: surface });
  },
  closeCompactSurface() {
    set({ compactSurface: null });
  },
  toggleSidebarCollapsed() {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
  },
  setSidebarWidth(width) {
    set({ sidebarWidth: clampPanelWidth("sidebar", width) });
  },
  setInspectorWidth(width) {
    set({ inspectorWidth: clampPanelWidth("inspector", width) });
  },
  setInspectorOpen(open) {
    set({ inspectorOpen: open });
  },
});

/** The session record for a tab: local projects first, then every joined instance's. */
export function findRecord(
  state: BackendState | null,
  tabId: string,
): SessionSummary | undefined {
  if (state === null) return undefined;
  for (const project of state.projects) {
    const record = project.sessions.find((session) => session.tabId === tabId);
    if (record) return record;
  }
  for (const instance of state.remoteInstances) {
    for (const project of instance.projects) {
      const record = project.sessions.find((session) => session.tabId === tabId);
      if (record) return record;
    }
  }
  return undefined;
}

/**
 * The session record for a tab together with the instance that owns it
 * (null = local). Search order is local, then remote instances in state
 * order; a tabId duplicated across instances resolves to the first.
 */
export function findOwner(
  state: BackendState | null,
  tabId: string,
): { instanceId: string | null; record: SessionSummary } | undefined {
  if (state === null) return undefined;
  for (const project of state.projects) {
    const record = project.sessions.find((session) => session.tabId === tabId);
    if (record) return { instanceId: null, record };
  }
  for (const instance of state.remoteInstances) {
    for (const project of instance.projects) {
      const record = project.sessions.find((session) => session.tabId === tabId);
      if (record) return { instanceId: instance.id, record };
    }
  }
  return undefined;
}

export function findInstance(
  state: BackendState | null,
  id: string | null,
): RemoteInstanceSummary | undefined {
  if (id === null) return undefined;
  return state?.remoteInstances.find((instance) => instance.id === id);
}

/** The session's effective working tree: its worktree checkout, else the project root. */
export function sessionCwd(
  rec: Pick<OwnedSessionRecord, "projectCwd" | "worktree"> | undefined,
): string | undefined {
  return rec ? (rec.worktree?.path ?? rec.projectCwd) : undefined;
}

/**
 * Other sessions running in the same worktree checkout — a fork of this
 * session, or a plan handoff that reused its checkout (issue #316). While any
 * exist, releasing this session keeps the checkout and its branch.
 */
export function worktreeSharers(
  state: BackendState | null,
  tabId: string,
  worktreePath: string,
): SessionSummary[] {
  return (state?.projects ?? []).flatMap((project) =>
    project.sessions.filter((s) => s.tabId !== tabId && s.worktree?.path === worktreePath),
  );
}

/**
 * The title of a session mid-turn on the given checkout, or null when none.
 * Matched on the effective cwd, so a running worktree session guards its own
 * checkout, not the project root its tab is registered under. `excludeTabId`
 * drops one tab from consideration (the caller's own); absent, every tab counts.
 */
export function runningSessionTitleOnCheckout(
  s: Pick<UiStore, "state" | "tabs" | "rpc">,
  cwd: string | undefined,
  excludeTabId?: string,
): string | null {
  if (cwd === undefined) return null;
  const tab = s.tabs.find(
    (t) =>
      t.tabId !== excludeTabId &&
      sessionCwd(findRecord(s.state, t.tabId)) === cwd &&
      s.rpc[t.tabId]?.status === "running",
  );
  return tab ? (findRecord(s.state, tab.tabId)?.title ?? "a session") : null;
}
