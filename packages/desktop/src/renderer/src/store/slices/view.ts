import type { BackendState, SessionSummary } from "@omp-ui/core/types";
import type { StateCreator, StoreApi } from "zustand";
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
import type { CompactSurface, UiStore } from "../types";

export type { CompactSurface } from "../types";


export interface ViewSlice {
  tabs: UiStore["tabs"];
  activeTabId: string | null;
  focusedTabByProject: Record<string, string>;
  restoringTabs: boolean;
  projectPickerOpen: boolean;
  mcpManager: { projectCwd: string | null; tabId?: string } | null;
  compactSurface: CompactSurface | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  inspectorOpen: boolean;
  openProjectPicker(): void;
  closeProjectPicker(): void;
  openMcpManager(projectCwd: string | null, tabId?: string): void;
  closeMcpManager(): void;
  showCompactSurface(surface: CompactSurface): void;
  closeCompactSurface(): void;
  toggleSidebarCollapsed(): void;
  setSidebarWidth(width: number): void;
  setInspectorWidth(width: number): void;
  setInspectorOpen(open: boolean): void;
}

/** Keeps global and per-project focus in lockstep for every tab activation. */
export function focusOn(
  state: Pick<UiStore, "activeTabId" | "focusedTabByProject">,
  tabId: string,
  projectCwd: string | undefined,
): Pick<UiStore, "activeTabId" | "focusedTabByProject"> {
  return {
    activeTabId: tabId,
    focusedTabByProject:
      projectCwd === undefined
        ? state.focusedTabByProject
        : { ...state.focusedTabByProject, [projectCwd]: tabId },
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
  const [projectCwd] = entry;
  const remaining = tabs.filter((tab) => !tab.hidden && tab.projectCwd === projectCwd);
  const next = { ...focusedTabByProject };
  if (remaining.length > 0) next[projectCwd] = remaining[remaining.length - 1]!.tabId;
  else delete next[projectCwd];
  return next;
}

/** Removes focus entries whose project or tab no longer exists in backend state. */
export function pruneFocus(
  focusedTabByProject: Record<string, string>,
  state: BackendState,
): Record<string, string> {
  const projects = new Set(state.projects.map((group) => group.project.path));
  const tabIds = new Set(state.projects.flatMap((group) => group.sessions.map((session) => session.tabId)));
  const next: Record<string, string> = {};
  let changed = false;
  for (const [projectCwd, tabId] of Object.entries(focusedTabByProject)) {
    if (projects.has(projectCwd) && tabIds.has(tabId)) next[projectCwd] = tabId;
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
    const record = findRecord(get().state, tabId);
    if (record) lastRestoredByProject.set(record.projectCwd, tabId);
  }
  for (const [projectCwd, tabId] of Object.entries(saved.focusedTabByProject)) {
    if (restoredSet.has(tabId)) focusedTabByProject[projectCwd] = tabId;
  }
  for (const [projectCwd, tabId] of lastRestoredByProject) {
    if (!(projectCwd in focusedTabByProject)) focusedTabByProject[projectCwd] = tabId;
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

export const createViewSlice: StateCreator<UiStore, [], [], ViewSlice> = (set) => ({
  tabs: [],
  activeTabId: null,
  focusedTabByProject: {},
  restoringTabs: false,
  projectPickerOpen: false,
  mcpManager: null,
  compactSurface: null,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  inspectorOpen: false,

  openProjectPicker() {
    set({ projectPickerOpen: true });
  },
  closeProjectPicker() {
    set({ projectPickerOpen: false });
  },
  openMcpManager(projectCwd, tabId) {
    set({ mcpManager: tabId === undefined ? { projectCwd } : { projectCwd, tabId } });
  },
  closeMcpManager() {
    set({ mcpManager: null });
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

export function findRecord(
  state: BackendState | null,
  tabId: string,
): SessionSummary | undefined {
  for (const project of state?.projects ?? []) {
    const record = project.sessions.find((session) => session.tabId === tabId);
    if (record) return record;
  }
  return undefined;
}
