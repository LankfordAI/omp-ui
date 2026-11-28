import type {
  BackendState,
  OwnedSessionRecord,
  RemoteInstanceSummary,
  SessionSummary,
  SessionWorktree,
} from "@omp-ui/core/types";
import type { FleetRung } from "@omp-ui/core/fleet";
import type { ProjectSettingsSectionId } from "../../components/ProjectSettings";
import type { CapabilitySectionId } from "@omp-ui/core/capabilities";
import type { StateCreator, StoreApi } from "zustand";
import { backend, displayMessage } from "../../backend";
import {
  desktopViewStorage,
  loadDesktopView,
  projectDesktopView,
  saveDesktopView,
  sessionViewStorage,
  shouldRestoreBrowserView,
  shouldRestoreDesktopView,
  type DesktopViewStateV1,
} from "../../lib/desktop-view-state";
import { projectFaces, type ProjectFace } from "../../lib/repository-members";
import { projectKey } from "../../lib/project-key";
import { IS_ELECTRON } from "../../lib/platform";
import { androidViewStorage, isAndroidShell } from "../../lib/android-shell";
import {
  BROWSER_PANE_DEFAULT_WIDTH,
  DEVICE_PANE_DEFAULT_WIDTH,
  clampPanelWidth,
  INSPECTOR_DEFAULT_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  type RailTab,
} from "../../lib/panel-layout";
import { randomId } from "../../lib/random-id";
import { markSharePrivacySeen } from "../../lib/share-privacy";
import type { StoreMachinery } from "./shared";
import type { CompactSurface, ErrorNotice, UiStore } from "../types";
import { bumpLiveVoiceGeneration, cancelLiveSwitch } from "./live-switch";
import { TREE_COMMAND } from "@omp-ui/core/session-tree";
import { hasAnyRoutinesHost } from "./routines";

export type { CompactSurface } from "../types";


export interface ViewSlice {
  tabs: UiStore["tabs"];
  activeTabId: string | null;
  restoringTabs: boolean;
  projectPickerOpen: boolean;
  projectPickerInstanceId: string | null;
  /** True while the first-run Getting started checklist overlay is open (issue #623). */
  gettingStartedOpen: boolean;
  /** The diagnostic-bundle export dialog (issue #413). */
  diagnosticsDialogOpen: boolean;
  browserPaneClearDialogOpen: boolean;
  /** The tab whose first-share privacy dialog is open (issue #679); null = closed. */
  shareConfirmTab: string | null;
  /** The tab whose Schedule dialog is open (issue #987); null = closed. */
  scheduleDialogTab: string | null;
  /** Non-null while the model picker hotkey asks a tab's ModelSelector to open
   *  its palette; consumed (cleared) by that selector in the same commit. */
  modelPickerTab: string | null;
  /** The New session dialog (one launcher for local and fleet work); null = closed. */
  newSessionDialog: {
    /** Seed project; null opens with the first registry project. */
    projectCwd: string | null;
    /** Owner of that project; null = this app's registry / LOCAL_MACHINE_KEY. */
    instanceId: string | null;
    /** Which Where face is active at open. */
    where: "here" | "fleet";
    /** Workspace capsule value at open. */
    workspace: "checkout" | "worktree";
  } | null;
  /** The project quick-open overlay (T3-style new-thread picker); null = closed. */
  projectQuickOpen: {
    /** Seed query pre-typed at open; usually empty. */
    query: string;
  } | null;
  /** The row whose Migrate session dialog is open (issue #888); null = closed. */
  migrateDialog: { tabId: string } | null;
  /** This computer's project whose Copy project dialog is open (issue #992); null = closed. */
  copyProjectDialog: UiStore["copyProjectDialog"];
  /** The shared grant-raise ceremony modal (issue #1398); null = closed. */
  grantCeremony: UiStore["grantCeremony"];
  /** App-global successes awaiting acknowledgment, oldest first (issue #888). */
  infoNotices: UiStore["infoNotices"];
  reportNotice(message: string): void;
  dismissNotice(id: string): void;
  /** The tab whose Finish worktree dialog is open (issues #385–#389); null = closed. */
  finishWorktreeTab: string | null;
  /** The session tree navigator (issue #680, Phase 2): the pinned live tab
   *  whose tree is open; null = closed. Same shape as `capabilitiesViewer`. */
  sessionTreeView: { tabId: string } | null;
  capabilitiesViewer: {
    scopeCwd: string | null;
    tabId?: string;
    section: CapabilitySectionId;
    instanceId: string | null;
  } | null;
	projectSettings: { projectCwd: string; instanceId: string | null; section?: ProjectSettingsSectionId } | null;
  ptyRedrawRevision: Record<string, number>;
  compactSurface: CompactSurface | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  inspectorOpen: boolean;
  /**
   * A pending request to show one rail pane for a tab (issue #682). The rail's
   * own selection is a module map nothing else can poke, so the request
   * carries a `nonce` the mounted rail compares against the last one it
   * handled; the rail applies it, opens itself, and remembers the pane.
   */
  railPaneFocus: Record<string, { pane: RailTab; nonce: number }>;
  focusRailPane(tabId: string, pane: RailTab): void;
  /** Split browser pane width preference (issue #519); persisted beside the other two. */
  browserPaneWidth: number;
  /** Split device pane width preference (issue #1006); persisted beside the browser pane's. */
  devicePaneWidth: number;
  /** Diff viewer layout preference (issue #933); persisted beside the widths. */
  diffViewLayout: "unified" | "split";
  openProjectPicker(instanceId?: string | null): void;
  closeProjectPicker(): void;
  openDiagnosticsDialog(): void;
  closeDiagnosticsDialog(): void;
  openGettingStarted(): void;
  dismissGettingStarted(): void;
  openBrowserPaneClearDialog(): void;
  closeBrowserPaneClearDialog(): void;
  /** Records the first-share privacy flag and forwards /share for the tab (issue #679). */
  confirmSharePrivacy(tabId: string): Promise<void>;
  openScheduleDialog(tabId: string): void;
  closeScheduleDialog(): void;
  openModelPicker(tabId: string): void;
  closeModelPicker(): void;
  cancelSharePrivacy(): void;
  openNewSessionDialog(seed?: {
    projectCwd?: string | null;
    instanceId?: string | null;
    where?: "here" | "fleet";
    workspace?: "checkout" | "worktree";
  }): void;
  closeNewSessionDialog(): void;
  openProjectQuickOpen(seed?: { query?: string }): void;
  closeProjectQuickOpen(): void;
  openMigrateDialog(tabId: string): void;
  closeMigrateDialog(): void;
  openCopyProjectDialog(projectCwd: string, name: string): void;
  closeCopyProjectDialog(): void;
  openGrantCeremony(instanceId: string, machineName: string, neededRung: FleetRung): void;
  closeGrantCeremony(): void;
  openFinishWorktree(tabId: string): void;
  closeFinishWorktree(): void;
  /** Opens the tree navigator for a live tab and arms its bridge (issue #680). */
  openSessionTreeView(tabId: string): void;
  closeSessionTreeView(): void;
  openCapabilitiesViewer(
    scopeCwd: string | null,
    tabId?: string,
    section?: CapabilitySectionId,
    instanceId?: string | null,
  ): void;
  closeCapabilitiesViewer(): void;
	openProjectSettings(projectCwd: string, instanceId?: string | null, section?: ProjectSettingsSectionId): void;
	closeProjectSettings(): void;
  showCompactSurface(surface: CompactSurface): void;
  closeCompactSurface(): void;
  /** Returns the main pane to the Welcome screen without closing any tab (issue #1327). */
  goHome(): void;
  toggleSidebarCollapsed(): void;
  setSidebarWidth(width: number): void;
  setInspectorWidth(width: number): void;
  setInspectorOpen(open: boolean): void;
  setBrowserPaneWidth(width: number): void;
  setDevicePaneWidth(width: number): void;
  setDiffViewLayout(layout: "unified" | "split"): void;
  /**
   * Backend failures awaiting acknowledgment (issue #373): the renderer-side
   * replacement for window.alert. Arrival order is kept; nothing times out,
   * dedupes, or silently replaces an earlier error.
   */
  errorNotices: ErrorNotice[];
  reportError(error: unknown): void;
  dismissError(id: string): void;
}

let navigationGeneration = 0;
export function bumpNavigationGeneration(): number { return ++navigationGeneration; }
export function getNavigationGeneration(): number { return navigationGeneration; }

/**
 * Moves the global focus for a tab activation. Activating a tab also closes
 * the Lab, the Stats view, the Fleet view, a shown fleet terminal, and the
 * Routines view (issues #559, #668, #899, #991, #1261): the main pane shows
 * one thing at a time.
 */
export function focusOn(
  tabId: string,
): Pick<UiStore, "activeTabId" | "lab" | "stats" | "fleet" | "fleetTerminal" | "artifacts" | "routinesOpen"> {
  bumpNavigationGeneration();
  return { activeTabId: tabId, lab: null, stats: null, fleet: null, fleetTerminal: null, artifacts: null, routinesOpen: false };
}

/**
 * True when the main pane is showing the Welcome (home) screen: no visible
 * focused tab and no full-pane overlay open. Matches App.tsx's Welcome gate.
 */
export function isHomeView(
  s: Pick<
    UiStore,
    | "tabs"
    | "activeTabId"
    | "artifacts"
    | "routinesOpen"
    | "lab"
    | "stats"
    | "fleet"
    | "fleetTerminal"
    | "state"
  >,
): boolean {
  const shownTab = s.tabs.some((t) => t.tabId === s.activeTabId && !t.hidden);
  if (shownTab) return false;
  if (s.artifacts !== null && s.state?.artifactLibraryEnabled === true) return false;
  if (s.routinesOpen && hasAnyRoutinesHost(s.state)) return false;
  if (s.lab !== null && s.state?.experimentsEnabled === true) return false;
  if (s.stats !== null) return false;
  if (s.fleet !== null) return false;
  if (
    s.fleetTerminal !== null &&
    (s.state?.fleetTerminals ?? []).some((ft) => ft.terminalId === s.fleetTerminal)
  ) {
    return false;
  }
  return true;
}

/**
 * Reattaches sessions whose process is still running, in saved renderer
 * order, then settles focus to them (issue #1241). Restore never respawns: a
 * dormant, settled, archived, or missing record is skipped and stays in the
 * sidebar's Settled/active lists for an explicit one-click resume. On
 * Electron every local session is dormant after quit (`killAll`), so a
 * desktop relaunch lands on the startup screen unless a process outlived
 * this client (a detached or remote-host session, a shared backend).
 */
export async function restoreSavedTabs(
  get: StoreApi<UiStore>["getState"],
  set: StoreApi<UiStore>["setState"],
  saved: DesktopViewStateV1,
): Promise<void> {
  const restored: string[] = [];
  for (const tabId of saved.tabIds) {
    const record = findRecord(get().state, tabId);
    // Live-only restore: only a running process reattaches. `archived` and
    // `missing` were already skipped; `dormant` joins them (issue #1241).
    if (record === undefined || record.live !== "live") continue;
    if (!IS_ELECTRON && isAndroidShell()) {
      // The host owns process lifetime. Android recovery only reattaches views;
      // even an id saved while live may have settled while this app was gone.
      const owner = findOwner(get().state, tabId);
      if (owner?.record.live !== "live") continue;
      const instance = findInstance(get().state, owner.instanceId);
      if (instance !== undefined && instance.status !== "joined") continue;
      const record = owner.record;
      set((state) => ({
        tabs: [
          ...state.tabs.filter((tab) => tab.tabId !== tabId),
          { tabId, mode: record.mode, projectCwd: record.projectCwd, hidden: false, instanceId: owner.instanceId },
        ],
      }));
      restored.push(tabId);
      continue;
    }
    await get().openSession(tabId, { forkCheck: false });
    if (get().tabs.some((tab) => tab.tabId === tabId)) restored.push(tabId);
  }

  const restoredSet = new Set(restored);
  const activeTabId =
    saved.activeTabId !== null && restoredSet.has(saved.activeTabId)
      ? saved.activeTabId
      : (restored.at(-1) ?? null);
  set({ activeTabId });
}

/** Restores the saved view after initialization's combined backend commit. */
export async function restoreDesktopView(api: StoreApi<UiStore>): Promise<void> {
  // Android survives process loss, browsers retain per-tab reload semantics,
  // and Electron keeps the desktop update/version gate unchanged.
  const android = !IS_ELECTRON && isAndroidShell();
  const storage = IS_ELECTRON ? desktopViewStorage() : android ? androidViewStorage() : sessionViewStorage();
  if (storage === null) return;
  const saved = loadDesktopView(storage);
  // Panel widths are cross-tab preferences: a browser client still takes them from
  // the localStorage blob when one exists, falling back to its own snapshot.
  const widthStorage = IS_ELECTRON || android ? null : desktopViewStorage();
  const widths = widthStorage === null ? saved : (loadDesktopView(widthStorage) ?? saved);
  const currentVersion = api.getState().appUpdate.currentVersion;
  if (widths !== null) {
    api.setState({
      sidebarWidth: widths.sidebarWidth,
      inspectorWidth: widths.inspectorWidth,
      browserPaneWidth: widths.browserPaneWidth,
      devicePaneWidth: widths.devicePaneWidth,
      diffViewLayout: widths.diffViewLayout,
    });
  }
  const restore = IS_ELECTRON
    ? shouldRestoreDesktopView(saved, currentVersion)
    : shouldRestoreBrowserView(saved);
  if (restore && saved !== null) {
    api.setState({ restoringTabs: true });
    try {
      await restoreSavedTabs(api.getState, api.setState, saved);
    } finally {
      api.setState({ restoringTabs: false });
    }
  }
  if (currentVersion !== null || android) {
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
      state.exited === previous.exited &&
      state.activeTabId === previous.activeTabId &&
      state.appUpdate.currentVersion === previous.appUpdate.currentVersion &&
      state.sidebarWidth === previous.sidebarWidth &&
      state.inspectorWidth === previous.inspectorWidth &&
      state.browserPaneWidth === previous.browserPaneWidth &&
      state.devicePaneWidth === previous.devicePaneWidth &&
      state.diffViewLayout === previous.diffViewLayout
    ) {
      return;
    }
    const version = state.appUpdate.currentVersion;
    const android = !IS_ELECTRON && isAndroidShell();
    const storage = IS_ELECTRON ? desktopViewStorage() : android ? androidViewStorage() : sessionViewStorage();
    if (storage === null || (version === null && !android)) return;
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
 * Shared with the browser pane's frame subscription (#529), which keys its
 * sink by the same id so one renderer never holds two subscriptions.
 */
export function viewedClientId(): string {
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
    backend.tabViewed(viewedClientId(), api.getState().activeTabId);
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

const liveGuardInstalled = new WeakSet<StoreApi<UiStore>>();

/**
 * Parks the live session of every armed tab the user leaves and resumes the
 * armed session they return to (#811), replacing the #801 mute guard: omp
 * records audio per session, so an unviewed tab must not listen at all —
 * closing the call is the honest mute. The rule mirrors the push-to-talk
 * hotkey's `activeTabId === tabId` gate (#707): tab visibility only — a
 * window blur leaves the sessions as they are.
 *
 * Parking keeps `liveArmed` — the user never asked to stop — and folding the
 * spoken turns into the recap before the stop lets the resume's
 * `live_connect { instructions }` carry the conversation on (#811). The owner
 * gate (#803) parks only in the renderer whose `live_connect` succeeded; a
 * second client viewing the same tab never disturbs the call. The enter
 * path is idempotent: `startLiveVoice` refuses while a call is open and
 * clears `liveParked` on its ack, so at most one call stays open (AC 6).
 */
export function installLiveVoiceParkResumeGuard(
  api: StoreApi<UiStore>,
  m: StoreMachinery,
): () => void {
  if (liveGuardInstalled.has(api)) return () => {};
  liveGuardInstalled.add(api);
  const unsubscribe = api.subscribe((state, previous) => {
    if (state.activeTabId === previous.activeTabId) return;
    // Leave: park an armed session behind us. The snapshot reads the same
    // between the two states for a pure tab switch; the rpc entry first,
    // because m.runtime auto-creates and a PTY tab must never gain one.
    const left = previous.activeTabId;
    if (left !== null && state.rpc[left] !== undefined) {
      const rt = m.runtime(left);
      // Leaving cancels even a start whose acknowledgment has not landed.
      bumpLiveVoiceGeneration(left);
      cancelLiveSwitch(left);
      const live = state.rpc[left]!.live;
      if (
        rt.liveVoiceOwner === true &&
        rt.liveArmed === true &&
        live != null && !live.ended
      )
        void state.switchLiveVoice(left, { mode: "park" });
    }
    // Enter: resume an armed, parked session.
    const entered = state.activeTabId;
    if (entered === null || state.rpc[entered] === undefined) return;
    const rt = m.runtime(entered);
    state.reconcileLivePlanReview(entered);
    if (rt.liveVoiceOwner !== true || rt.liveArmed !== true || rt.liveParked !== true)
      return;
    void state.switchLiveVoice(entered, { mode: "wake" });
  });
  return unsubscribe;
}

export const createViewSlice: StateCreator<UiStore, [], [], ViewSlice> = (set, get) => ({
  tabs: [],
  activeTabId: null,
  restoringTabs: false,
  projectPickerOpen: false,
  projectPickerInstanceId: null,
  gettingStartedOpen: false,
  diagnosticsDialogOpen: false,
  browserPaneClearDialogOpen: false,
  shareConfirmTab: null,
  scheduleDialogTab: null,
  modelPickerTab: null,
  newSessionDialog: null,
  projectQuickOpen: null,
  finishWorktreeTab: null,
  sessionTreeView: null,
  migrateDialog: null,
  copyProjectDialog: null,
  grantCeremony: null,
  capabilitiesViewer: null,
	projectSettings: null,
  ptyRedrawRevision: {},
  compactSurface: null,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  inspectorOpen: false,
  railPaneFocus: {},
  browserPaneWidth: BROWSER_PANE_DEFAULT_WIDTH,
  devicePaneWidth: DEVICE_PANE_DEFAULT_WIDTH,
  diffViewLayout: "unified",
  errorNotices: [],
  reportError(error) {
    set((s) => ({
      errorNotices: [
        ...s.errorNotices,
        {
          id: randomId(),
          message: displayMessage(error),
        },
      ],
    }));
  },
  dismissError(id) {
    set((s) => ({ errorNotices: s.errorNotices.filter((n) => n.id !== id) }));
  },
  infoNotices: [],
  reportNotice(message) {
    set((s) => ({ infoNotices: [...s.infoNotices, { id: randomId(), message }] }));
  },
  dismissNotice(id) {
    set((s) => ({ infoNotices: s.infoNotices.filter((n) => n.id !== id) }));
  },

  openProjectPicker(instanceId = null) {
    // React hands click handlers the event as the first argument: only a
    // string is an instance id — anything else registers on the local
    // registry (#624).
    set({
      projectPickerOpen: true,
      projectPickerInstanceId: typeof instanceId === "string" ? instanceId : null,
    });
  },
  closeProjectPicker() {
    set({ projectPickerOpen: false, projectPickerInstanceId: null });
  },
  openGettingStarted() {
    set({ gettingStartedOpen: true });
  },
  dismissGettingStarted() {
    set({ gettingStartedOpen: false });
    // Mark the checklist seen once, on the first dismissal that finds the
    // authoritative flag still false; a palette re-open on an old install
    // stays a read.
    if (get().state?.gettingStartedSeen === false) {
      backend.setGettingStartedSeen(true).catch((err) => get().reportError(err));
    }
  },
  openDiagnosticsDialog() {
    set({ diagnosticsDialogOpen: true });
  },
  closeDiagnosticsDialog() {
    set({ diagnosticsDialogOpen: false });
  },
  openBrowserPaneClearDialog() {
    set({ browserPaneClearDialogOpen: true });
  },
  closeBrowserPaneClearDialog() {
    set({ browserPaneClearDialogOpen: false });
  },
  async confirmSharePrivacy(tabId) {
    markSharePrivacySeen();
    set({ shareConfirmTab: null });
    await get().runSlashCommand(tabId, "/share");
  },
  cancelSharePrivacy() {
    set({ shareConfirmTab: null });
  },
  openScheduleDialog(tabId) {
    set({ scheduleDialogTab: tabId });
  },
  closeScheduleDialog() {
    set({ scheduleDialogTab: null });
  },
  openModelPicker(tabId) {
    set({ modelPickerTab: tabId });
  },
  closeModelPicker() {
    set({ modelPickerTab: null });
  },
  openNewSessionDialog(seed) {
    set({
      newSessionDialog: {
        projectCwd: seed?.projectCwd ?? null,
        instanceId: seed?.instanceId ?? null,
        where: seed?.where ?? "here",
        workspace: seed?.workspace ?? "worktree",
      },
    });
  },
  closeNewSessionDialog() {
    set({ newSessionDialog: null });
  },
  openProjectQuickOpen(seed) {
    set({ projectQuickOpen: { query: seed?.query ?? "" } });
  },
  closeProjectQuickOpen() {
    set({ projectQuickOpen: null });
  },
  openMigrateDialog(tabId) {
    set({ migrateDialog: { tabId } });
  },
  closeMigrateDialog() {
    set({ migrateDialog: null });
  },
  openCopyProjectDialog(projectCwd, name) {
    set({ copyProjectDialog: { projectCwd, name } });
  },
  closeCopyProjectDialog() {
    set({ copyProjectDialog: null });
  },
  openGrantCeremony(instanceId, machineName, neededRung) {
    set({ grantCeremony: { instanceId, machineName, neededRung } });
  },
  closeGrantCeremony() {
    set({ grantCeremony: null });
  },
  openFinishWorktree(tabId) {
    set({ finishWorktreeTab: tabId });
  },
  closeFinishWorktree() {
    set({ finishWorktreeTab: null });
  },
  openSessionTreeView(tabId) {
    set({ sessionTreeView: { tabId } });
    // The quiet arm prompt binds the bridge's UI context and publishes the
    // first snapshot; a process without the bridge simply never publishes.
    void get().runHiddenCommand(tabId, TREE_COMMAND, "show");
  },
  closeSessionTreeView() {
    set({ sessionTreeView: null });
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
	openProjectSettings(projectCwd, instanceId = null, section) {
		set({ projectSettings: { projectCwd, instanceId, section } });
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
  goHome() {
    // closeLab() stops Lab's refresh timer before clearing the main pane.
    if (get().lab !== null) get().closeLab();
    bumpNavigationGeneration();
    set({
      activeTabId: null,
      lab: null,
      stats: null,
      fleet: null,
      fleetTerminal: null,
      artifacts: null,
      routinesOpen: false,
      routineFocusId: null,
    });
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
  focusRailPane(tabId, pane) {
    set((s) => ({
      railPaneFocus: {
        ...s.railPaneFocus,
        [tabId]: { pane, nonce: (s.railPaneFocus[tabId]?.nonce ?? 0) + 1 },
      },
    }));
  },
  setBrowserPaneWidth(width) {
    set({ browserPaneWidth: clampPanelWidth("browserPane", width) });
  },
  setDevicePaneWidth(width) {
    set({ devicePaneWidth: clampPanelWidth("devicePane", width) });
  },
  setDiffViewLayout(layout) {
    set({ diffViewLayout: layout });
  },
});

type SessionOwner = { instanceId: string | null; record: SessionSummary };
const ownerIndexes = new WeakMap<BackendState, ReadonlyMap<string, SessionOwner>>();

function ownerIndex(state: BackendState): ReadonlyMap<string, SessionOwner> {
  const cached = ownerIndexes.get(state);
  if (cached) return cached;
  const index = new Map<string, SessionOwner>();
  for (const project of state.projects) {
    for (const record of project.sessions) {
      if (!index.has(record.tabId)) index.set(record.tabId, { instanceId: null, record });
    }
  }
  for (const record of state.chats) {
    if (!index.has(record.tabId)) index.set(record.tabId, { instanceId: null, record });
  }
  for (const instance of state.remoteInstances) {
    for (const project of instance.projects) {
      for (const record of project.sessions) {
        if (!index.has(record.tabId)) {
          index.set(record.tabId, { instanceId: instance.id, record });
        }
      }
    }
  }
  ownerIndexes.set(state, index);
  return index;
}

/** The session record for a tab: local projects and chats first, then every joined instance's. */
export function findRecord(
  state: BackendState | null,
  tabId: string,
): SessionSummary | undefined {
  return state === null ? undefined : ownerIndex(state).get(tabId)?.record;
}

/** True when the tab's record is a Chat (CONTEXT.md). */
export function isChatTab(state: BackendState | null, tabId: string): boolean {
  return findRecord(state, tabId)?.chat === true;
}

/**
 * The session record for a tab together with the instance that owns it
 * (null = local). Search order is local, then remote instances in state
 * order; a tabId duplicated across instances resolves to the first.
 */
export function findOwner(
  state: BackendState | null,
  tabId: string,
): SessionOwner | undefined {
  return state === null ? undefined : ownerIndex(state).get(tabId);
}

/** The tab's project face; null for a chat or an unknown tab. Stable per BackendState. */
export function sessionProjectFace(state: BackendState | null, tabId: string): ProjectFace | null {
  if (state === null) return null;
  const owner = findOwner(state, tabId);
  if (owner === undefined || owner.record.chat) return null;
  return projectFaces(state).get(projectKey(owner.instanceId, owner.record.projectCwd)) ?? null;
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

/** One host's full session set: local projects plus chats, or a remote instance's projects. */
function hostSessions(state: BackendState, instanceId: string | null): SessionSummary[] {
  if (instanceId === null) return [...state.projects.flatMap((g) => g.sessions), ...state.chats];
  return findInstance(state, instanceId)?.projects.flatMap((g) => g.sessions) ?? [];
}

/** The session `tabId` was forked from (CONTEXT.md **Fork**), on the same host; null when not a fork or unresolved. */
export function forkSourceOf(state: BackendState | null, tabId: string): SessionSummary | null {
  const owner = findOwner(state, tabId);
  const sourceTabId = owner?.record.forkSourceTabId ?? null;
  if (owner === undefined || sourceTabId === null) return null;
  const source = findOwner(state, sourceTabId);
  return source !== undefined && source.instanceId === owner.instanceId ? source.record : null;
}

/** Running sessions forked directly from `tabId` on the same host, newest launch first. */
export function liveForksOf(state: BackendState | null, tabId: string): SessionSummary[] {
  const owner = findOwner(state, tabId);
  if (state === null || owner === undefined) return [];
  return hostSessions(state, owner.instanceId)
    .filter((s) => s.live === "live" && s.forkSourceTabId === tabId)
    .sort((a, b) => b.launchedAt.localeCompare(a.launchedAt));
}

/** The registered project and worktree whose checkout is at `path`, or null
 * when that path is no session's worktree (i.e. it is a project root). */
export function findWorktreeAt(
  state: BackendState | null,
  path: string,
): { instanceId: string | null; projectCwd: string; worktree: SessionWorktree } | null {
  if (state === null) return null;
  for (const project of state.projects) {
    for (const s of project.sessions) {
      if (s.worktree?.path === path) {
        return { instanceId: null, projectCwd: s.projectCwd, worktree: s.worktree };
      }
    }
  }
  for (const instance of state.remoteInstances) {
    for (const project of instance.projects) {
      for (const s of project.sessions) {
        if (s.worktree?.path === path) {
          return { instanceId: instance.id, projectCwd: s.projectCwd, worktree: s.worktree };
        }
      }
    }
  }
  return null;
}

/**
 * Finds the owning host's session holding a linked worktree at `holderPath`,
 * preferring live/unsettled sessions over dormant/settled ones.
 */
export function findWorktreeHolderSession(
  state: BackendState | null,
  instanceId: string | null,
  holderPath: string,
): SessionSummary | null {
  if (state === null) return null;
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "") || "/";
    return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
  };
  const target = norm(holderPath);
  const matches = hostSessions(state, instanceId).filter(
    (s) => s.worktree !== null && norm(s.worktree.path) === target,
  );
  if (matches.length === 0) return null;
  const rank = (s: SessionSummary): number =>
    (s.live === "live" ? 2 : 0) + (s.settledAtMs === null ? 1 : 0);
  matches.sort((a, b) => rank(b) - rank(a) || b.launchedAt.localeCompare(a.launchedAt));
  return matches[0]!;
}

export interface CheckoutOccupant {
  tabId: string;
  title: string;
  reason: "running" | "build-live" | "pty-live";
}

/** Formats an occupant's state into short human-readable prose for warnings. */
export function occupantActivityPhrase(reason: CheckoutOccupant["reason"]): string {
  if (reason === "running") return "is mid-turn";
  if (reason === "pty-live") return "is running in a terminal on this checkout";
  return "is active in Build mode on this checkout";
}

/**
 * Another live, unsettled, non-snoozed session occupying `cwd` on `instanceId`,
 * or null when the checkout is free. Scans all sessions on that host (not only
 * mounted local tabs) and ranks mid-turn (`"running"`) ahead of idle Build or
 * live PTY sessions.
 */
export function checkoutOccupant(
  s: Pick<UiStore, "state" | "tabs" | "rpc">,
  cwd: string | undefined,
  excludeTabId?: string,
  instanceId: string | null = null,
): CheckoutOccupant | null {
  if (cwd === undefined || s.state === null) return null;
  let fallback: CheckoutOccupant | null = null;
  for (const rec of hostSessions(s.state, instanceId)) {
    if (rec.tabId === excludeTabId) continue;
    if (sessionCwd(rec) !== cwd) continue;
    if (rec.live !== "live" || rec.settledAtMs !== null || rec.snoozed) continue;
    const title = rec.title ?? "a session";
    if (rec.turnRunning === true || s.rpc[rec.tabId]?.status === "running") {
      return { tabId: rec.tabId, title, reason: "running" };
    }
    if (fallback === null) {
      if (rec.mode === "rpc-ui" && rec.agentMode === "build" && rec.sessionId !== null) {
        fallback = { tabId: rec.tabId, title, reason: "build-live" };
      } else if (rec.mode === "pty") {
        fallback = { tabId: rec.tabId, title, reason: "pty-live" };
      }
    }
  }
  return fallback;
}

/**
 * Resolves a project's effective workspace policy on `instanceId`:
 * project override -> host global setting -> `"auto"`.
 */
export function effectiveWorkspacePolicy(
  state: BackendState | null,
  projectCwd: string | undefined,
  instanceId: string | null = null,
): "auto" | "worktree" | "checkout" {
  const projects =
    state === null
      ? []
      : instanceId === null
        ? state.projects
        : (findInstance(state, instanceId)?.projects ?? []);
  const project =
    projectCwd === undefined
      ? undefined
      : projects.find((group) => group.project.path === projectCwd)?.project;
  const localOverride = project?.workspacePolicy ?? null;
  if (localOverride === "auto" || localOverride === "worktree" || localOverride === "checkout") {
    return localOverride;
  }
  const global = state?.workspacePolicy;
  if (global === "auto" || global === "worktree" || global === "checkout") return global;
  return "auto";
}
