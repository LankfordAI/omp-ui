import { create } from "zustand";
import type {
  BackendState,
  PlanImplementationSource,
} from "@omp-ui/core/types";
// (core/plan, advisor-stats, mcp-status imports moved to the frame-reduction slice for #295)
import { backend } from "./backend";
import type { PlanExecutionOptions } from "./lib/plan-concerns";
import { applyTheme, currentThemeId, resolveTheme } from "./lib/themes";
import { applyFontFamily, currentFontFamilyId, resolveFontFamily } from "./lib/font-families";
import { applyLocale, currentLocaleId, resolveLocale } from "./lib/i18n";
import { createBranchesSlice } from "./store/slices/branches";
import { createFrameReductionSlice } from "./store/slices/frame-reduction";
import { createLifecycleSlice } from "./store/slices/lifecycle";
import { createPlanExecutionSlice } from "./store/slices/plan-execution";
import { createRpcCommandSlice } from "./store/slices/rpc-command";
import { createSessionParamsSlice } from "./store/slices/session-params";
import { createSettingsSlice } from "./store/slices/settings";
import { createMachinery, shellWriters, termWriters } from "./store/slices/shared";
import { createUpdatesSlice } from "./store/slices/updates";
import {
  createViewSlice,
  findRecord,
  installDesktopViewPersistence,
  installViewedTabReporter,
  pruneFocus,
  restoreDesktopView,
} from "./store/slices/view";
import type { RpcTabState, UiStore } from "./store/types";
export type {
  BranchActivity,
  CompactSurface,
  CompactionMethodsLoad,
  DeleteConfirmation,
  ErrorNotice,
  LifecycleConfirmation,
  PlanRecord,
  PlanRevisionNotes,
  RpcFailure,
  RpcTabState,
  SettingsPage,
  SidebarSessionState,
  TabInfo,
  TuiHandoff,
  UiStore,
} from "./store/types";
export {
  findRecord,
  runningSessionTitleOnCheckout,
  sessionCwd,
  worktreeSharers,
} from "./store/slices/view";
export {
  USAGE_REFRESH_MS,
  QUEUE_SETTLE_REFRESH_MS,
  COMPACTION_USAGE_RETRY_MS,
  COMPACTION_USAGE_MAX_ATTEMPTS,
} from "./store/slices/frame-reduction";
export {
  RpcCommandTimeoutError,
  STREAM_STALL_THRESHOLD_MS,
  STREAM_STALL_TICK_MS,
  deriveSidebarSessionState,
  isLateAckCommand,
  registerShellWriter,
  registerTermWriter,
} from "./store/slices/shared";

// StrictMode double-invokes effects in dev, and the preload listener API has
// no unsubscribe — init must be idempotent or every listener registers twice.
let initialized = false;

export const useStore = create<UiStore>()((set, get, api) => {
  const m = createMachinery(set, get, api);
  const branchesSlice = createBranchesSlice(set, get);
  const plan = createPlanExecutionSlice(set, get, m, {
    spawnFreshImplementation: (
      tabId: string,
      planText: string | null,
      planImplementationSource: Readonly<PlanImplementationSource>,
      concerns: string | null,
      options?: PlanExecutionOptions,
    ) =>
      lifecycle.spawnFreshImplementation(tabId, planText, planImplementationSource, concerns, options),
  });
  const {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
    reconcilePlanGates,
  } = plan;
  const lifecycle = createLifecycleSlice(set, get, m, {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
  });
  const rpcCommandSlice = createRpcCommandSlice(set, get, m, {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
    reconcilePlanGates,
  });
  const sessionParams = createSessionParamsSlice(set, get, m, {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
    prepareRpcRelaunch: lifecycle.prepareRpcRelaunch,
  });
  const frame = createFrameReductionSlice(get, m, {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
  });

  /**
   * Repaints the document to match the registry's persisted themeId. The
   * registry stays authoritative; lib/themes.ts keeps only a localStorage
   * mirror so the first frame paints before this runs. The id guard is what
   * stops a redundant broadcast from re-writing ~28 custom properties on
   * every state change.
   */
  const syncTheme = (s: BackendState): void => {
    const t = resolveTheme(s.themeId);
    if (t.id !== currentThemeId()) applyTheme(t);
  };

  /**
   * Repaints the document to match the registry's persisted fontFamilyId —
   * the same registry-authoritative, localStorage-mirror split as syncTheme.
   * The id guard stops a redundant broadcast from re-writing the three
   * font properties on every state change.
   */
  const syncFontFamily = (s: BackendState): void => {
    const f = resolveFontFamily(s.fontFamilyId);
    if (f.id !== currentFontFamilyId()) applyFontFamily(f);
  };

  /**
   * Re-applies the registry's persisted localeId — the same
   * registry-authoritative, localStorage-mirror split as syncTheme.
   */
  const syncLocale = (s: BackendState): void => {
    const l = resolveLocale(s.localeId);
    if (l.id !== currentLocaleId()) applyLocale(l);
  };

  return {
    ...createViewSlice(set, get, api),
    ...createSettingsSlice(set, get, api),
    ...createUpdatesSlice(set, get, api),
    ...lifecycle,
    ...sessionParams,
    state: null,
    exited: {},
    hibernated: {},
    rpc: {},
    branches: branchesSlice.branches,
    branchActivity: branchesSlice.branchActivity,
    branchDiffRevision: branchesSlice.branchDiffRevision,
    refreshBranches: branchesSlice.refreshBranches,
    checkoutGitBranch: branchesSlice.checkoutGitBranch,
    pullGitBranch: branchesSlice.pullGitBranch,
    readMergeBackStatus: branchesSlice.readMergeBackStatus,
    mergeWorktreeBranch: branchesSlice.mergeWorktreeBranch,
    suggestBranchName: branchesSlice.suggestBranchName,

    async init() {
      if (initialized) return;
      initialized = true;
      backend.onStateChanged((state) => {
        set((s) => ({
          state,
          // Record mode is authoritative — tabs follow it (e.g. after switchMode).
          tabs: s.tabs.map((t) => {
            const rec = findRecord(state, t.tabId);
            return rec && rec.mode !== t.mode ? { ...t, mode: rec.mode } : t;
          }),
          focusedTabByProject: pruneFocus(s.focusedTabByProject, state),
        }));
        syncTheme(state);
        syncFontFamily(state);
        syncLocale(state);
        reconcilePlanGates(state);
      });
      backend.onPtyData((tabId, data) => termWriters.get(tabId)?.(data));
      backend.onPtyExit((tabId, code) =>
        lifecycle.teardownProcess(tabId, code),
      );
      backend.onSessionHibernated((tabId) =>
        lifecycle.teardownProcess(tabId, 0, true),
      );
      // OS notification click (issue #271): resurface the session's tab —
      // openSession is the hide/resurface path; main dedupes the resume
      // against a live process, so a late-joining renderer never
      // double-spawns. The event fans out to every renderer, so a click
      // resurfaces the tab in all of them.
      backend.onFocusSession((tabId) => {
        void get().openSession(tabId);
      });
      backend.onShellData((tabId, data) => shellWriters.get(tabId)?.(data));
      backend.onShellExit((tabId, code) => {
        set((s) => {
          // The handoff TUI quit, so its banner switches from "send" to
          // "restart session"; a plain login shell leaves the map identical.
          const staged = s.tuiHandoff[tabId];
          return {
            shellExited: { ...s.shellExited, [tabId]: code },
            tuiHandoff:
              staged && staged.phase !== "exited"
                ? { ...s.tuiHandoff, [tabId]: { ...staged, phase: "exited" } }
                : s.tuiHandoff,
          };
        });
      });
      backend.onRpcFrame((tabId, frame) => get().handleRpcFrame(tabId, frame));
      backend.onAppUpdateState((appUpdate) =>
        get().replaceAppUpdate(appUpdate),
      );
      backend.onOmpUpdateState((ompUpdate) =>
        get().replaceOmpUpdate(ompUpdate),
      );
      backend.onRemoteState((remote) => get().replaceRemote(remote));
      backend.onProviderOAuthState((s) => get().replaceProviderOAuth(s));
      const [state, appUpdate, ompUpdate, remote, providerOAuth] = await Promise.all([
        backend.getState(),
        backend.getAppUpdateState(),
        backend.getOmpUpdateState(),
        backend.getRemoteState(),
        backend.getProviderOAuthState(),
      ]);
      set({ state, appUpdate, ompUpdate, remote, providerOAuth });
      syncTheme(state);
      syncFontFamily(state);
      syncLocale(state);
      reconcilePlanGates(state);
      await restoreDesktopView(api);
      installDesktopViewPersistence(api);
      installViewedTabReporter(api);
    },

    bootRpcTab: rpcCommandSlice.bootRpcTab,
    refreshAvailableModels: rpcCommandSlice.refreshAvailableModels,
    refreshCapabilities: rpcCommandSlice.refreshCapabilities,
    rpcCommand: rpcCommandSlice.rpcCommand,
    handleRpcFrame: frame.handleRpcFrame,

    setInitialPrompt: rpcCommandSlice.setInitialPrompt,
    renameSession: rpcCommandSlice.renameSession,
    executePlan: plan.executePlan,
    refinePlan: plan.refinePlan,
    deferPlanReview: plan.deferPlanReview,
    showPlanReview: plan.showPlanReview,
    loadPlanText: plan.loadPlanText,

    appendNotice: frame.appendNotice,
  };
});

// Advisor auto-reply is an app-level setting (issue #111); each tab's
// advisorReply is a seeded snapshot of it. Any state write that flips the
// setting — a settings broadcast, init's first getState, a boot-time fetch —
// sweeps every open rpc tab. Module scope, not init(): the store module is
// evaluated once per renderer, and store tests never call the one-shot init().
useStore.subscribe((curr, prev) => {
  const next = curr.state?.advisorAutoReply;
  if (next === undefined || next === prev.state?.advisorAutoReply) return;
  let changed = false;
  const rpc: Record<string, RpcTabState> = {};
  for (const [tabId, tab] of Object.entries(curr.rpc)) {
    if (tab.advisorReply === next) {
      rpc[tabId] = tab;
    } else {
      rpc[tabId] = { ...tab, advisorReply: next };
      changed = true;
    }
  }
  if (changed) useStore.setState({ rpc });
});
