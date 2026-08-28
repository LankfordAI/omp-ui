import type {
  BackendState,
  OwnedSessionRecord,
  SessionSummary,
} from "@omp-ui/core/types";
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
import type { CompactSurface, UiStore } from "../types";

export type { CompactSurface } from "../types";


export interface ViewSlice {
  tabs: UiStore["tabs"];
  activeTabId: string | null;
  focusedTabByProject: Record<string, string>;
  restoringTabs: boolean;
  projectPickerOpen: boolean;
  worktreeDialogProject: string | null;
  mcpManager: { scopeCwd: string | null; tabId?: string } | null;
	projectSettings: { projectCwd: string } | null;
  compactSurface: CompactSurface | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  inspectorOpen: boolean;
  openProjectPicker(): void;
  closeProjectPicker(): void;
  openWorktreeDialog(projectCwd: string): void;
  closeWorktreeDialog(): void;
  openMcpManager(scopeCwd: string | null, tabId?: string): void;
  closeMcpManager(): void;
	openProjectSettings(projectCwd: string): void;
	closeProjectSettings(): void;
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
  worktreeDialogProject: null,
  mcpManager: null,
	projectSettings: null,
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
  openWorktreeDialog(projectCwd) {
    set({ worktreeDialogProject: projectCwd });
  },
  closeWorktreeDialog() {
    set({ worktreeDialogProject: null });
  },
  openMcpManager(scopeCwd, tabId) {
    set({ mcpManager: tabId === undefined ? { scopeCwd } : { scopeCwd, tabId } });
  },
  closeMcpManager() {
    set({ mcpManager: null });
  },
	openProjectSettings(projectCwd) {
		set({ projectSettings: { projectCwd } });
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
