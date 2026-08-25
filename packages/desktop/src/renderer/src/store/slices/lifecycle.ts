// Session lifecycle domain (decomposed for #295): project and tab ops,
// spawn/resume/switch, delete confirmation, TUI handoff, and the
// console/search drawer toggles.
import type {
  PlanImplementationSource,
  SessionMode,
} from "@omp-ui/core/types";
import { backend } from "../../backend";
import {
  withConcerns,
  withKeywords,
  type PlanExecutionOptions,
} from "../../lib/plan-concerns";
import { planSeedText } from "../../lib/plan-seed";
import { noticeItem } from "../../lib/transcript";
import {
  alertError,
  compactionUsageGenerations,
  dropExited,
  dropHibernated,
  dropTuiHandoff,
  handedOffPlanSources,
  quietWedgeNotified,
  timedOutCommands,
  type GetState,
  type SetState,
  type StoreMachinery,
  type Watchers,
} from "./shared";
import { findRecord, focusOn, forgetFocus } from "./view";
import type { UiStore } from "../types";

export type LifecycleSlice = Pick<
  UiStore,
  | "shellExited"
  | "consoleOpen"
  | "searchOpen"
  | "tuiHandoff"
  | "deleteConfirmation"
  | "restartSession"
  | "addProject"
  | "removeProject"
  | "moveProject"
  | "moveSession"
  | "setProjectDefaultModel"
  | "setProjectDefaultAdvisorModel"
  | "toggleFavorite"
  | "newSession"
  | "newWorktreeSession"
  | "convertSessionToWorktree"
  | "openSession"
  | "focusTab"
  | "hideTab"
  | "terminate"
  | "switchMode"
  | "resumeDead"
  | "deleteSession"
  | "confirmDeleteSession"
  | "cancelDeleteSession"
  | "clearShellExited"
  | "toggleConsole"
  | "openSearch"
  | "closeSearch"
  | "startTuiHandoff"
  | "sendTuiHandoff"
  | "dismissTuiHandoff"
> & {
  prepareRpcRelaunch(tabId: string): void;
  resolveSpawnParams(projectCwd: string): Promise<{
    mode: SessionMode;
    advisor: boolean;
    advisorModel: string | null;
  }>;
  eraseSession(tabId: string): Promise<void>;
  spawnFreshImplementation(
    tabId: string,
    planText: string | null,
    planImplementationSource: Readonly<PlanImplementationSource>,
    concerns: string | null,
    options?: PlanExecutionOptions,
  ): Promise<void>;
};

export type LifecycleDeps = Watchers;

export function createLifecycleSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
  deps: LifecycleDeps,
): LifecycleSlice {
  // The bodies moved from the root closure keep their original names.
  const {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
  } = deps;

  const prepareRpcRelaunch = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    // A flush queued by the dying process must not land in the fresh state.
    m.cancelTranscriptBatch(tabId);
    compactionUsageGenerations.delete(tabId);
    // No frames will come from the dying process: stop the stall clock now
    // rather than waiting for its next tick (issue #228).
    m.stopStreamStallTimer(tabId);
    // A fresh process has no wedge memory: re-arm the quiet-failure notice
    // and drop the attribution memory (issue #302).
    quietWedgeNotified.delete(tabId);
    timedOutCommands.delete(tabId);
    m.patchRpc(tabId, {
      status: "starting",
      plan: null,
      session: { ...tab.session, isStreaming: false },
      extensionQueue: [],
      planReview: null,
      planText: null,
      planHtml: null,
      planDeferred: false,
      failure: undefined,
      // A fresh process has no renderer-observed checkpoint: resetting it
      // also stops the #100 notice from citing the dead process's
      // "since turn started" (issue #228, #179).
      streamCheckpoint: undefined,
      streamStallMs: undefined,
    });
  };

  const eraseSession = async (tabId: string): Promise<void> => {
    try {
      await backend.deleteSession(tabId);
    } catch (err) {
      alertError(err);
      return;
    }
    const tab = get().rpc[tabId];
    // A dangling concern-wait timer must not fire into the dead tab's slot.
    concernWatcher.cancel(tabId);
    advisorReplyWatcher.cancel(tabId);
    stallContinueWatcher.cancel(tabId);
    m.cancelTranscriptBatch(tabId);
    m.slashCommandItems.delete(tabId);
    compactionUsageGenerations.delete(tabId);
    handedOffPlanSources.delete(tabId);
    quietWedgeNotified.delete(tabId);
    timedOutCommands.delete(tabId);
    if (tab) {
      for (const pending of tab.pendingCommands.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("session deleted"));
      }
    }
    set((s) => {
      const rpc = { ...s.rpc };
      delete rpc[tabId];
      const tabs = s.tabs.filter((t) => t.tabId !== tabId);
      const activeTabId =
        s.activeTabId === tabId
          ? (tabs.filter((t) => !t.hidden).at(-1)?.tabId ?? null)
          : s.activeTabId;
      const catchup = { ...s.catchup };
      delete catchup[tabId];
      const lastActiveAt = { ...s.lastActiveAt };
      delete lastActiveAt[tabId];
      return {
        rpc,
        tabs,
        activeTabId,
        focusedTabByProject: forgetFocus(s.focusedTabByProject, tabId, tabs),
        exited: dropExited(s.exited, tabId),
        tuiHandoff: dropTuiHandoff(s.tuiHandoff, tabId),
        catchup,
        lastActiveAt,
      };
    });
  };

  /**
   * Spawns a fresh rpc-ui session in the plan's project, seeds it with the
   * plan text as its first prompt, and surfaces it as the active tab.
   */
  const spawnFreshImplementation = async (
    srcTabId: string,
    planText: string | null,
    planImplementationSource: Readonly<PlanImplementationSource>,
    concerns: string | null = null,
    options?: PlanExecutionOptions,
  ): Promise<void> => {
    const rec = findRecord(get().state, srcTabId);
    if (!rec) return;
    const projectCwd = rec.projectCwd;
    // A staged tuple (the modal always sends one) wins over the project's
    // last-used defaults; legacy callers keep the fallback chain.
    await get().loadAdvisorDefaults(projectCwd);
    const defaults = get().advisorDefaults[projectCwd];
    const project = get().state?.projects.find(
      (g) => g.project.path === projectCwd,
    )?.project;
    const advisor =
      options?.advisor ??
      project?.lastAdvisor ??
      get().state?.defaultAdvisor ??
      defaults?.enabled ??
      false;
    const advisorModel =
      options?.advisor !== undefined
        ? (options.advisorModel ?? null)
        : (project?.defaultAdvisorModel ??
          project?.lastAdvisorModel ??
          defaults?.model ??
          null);
    let freshId: string;
    try {
      ({ tabId: freshId } = await backend.spawnSession({
        projectCwd,
        mode: "rpc-ui",
        advisor,
        advisorModel,
        cols: 80,
        rows: 24,
        startInPlanMode: false,
        planImplementationSource,
      }));
    } catch (err) {
      alertError(err);
      return;
    }
    set((s) => ({
      tabs: [
        ...s.tabs,
        { tabId: freshId, mode: "rpc-ui", projectCwd, hidden: false },
      ],
      ...focusOn(s, freshId, projectCwd),
      exited: dropExited(s.exited, freshId),
    }));
    await m.pollUntil(freshId, (t) => t?.status === "ready");
    if (get().rpc[freshId]?.status !== "ready") return;
    // Staged main-model parameters ride the composer's own actions, so they
    // persist into session parameter memory exactly like a composer change.
    const stagedModel = options?.model ?? null;
    if (stagedModel !== null) {
      const cur = get().rpc[freshId]?.model;
      if (
        `${stagedModel.provider}/${stagedModel.id}` !==
        (cur ? `${cur.provider}/${cur.id}` : null)
      ) {
        await get().setModel(freshId, stagedModel);
        if (get().rpc[freshId]?.failure?.command === "set_model") return;
      }
    }
    if (
      options?.thinkingLevel != null &&
      options.thinkingLevel !==
        (get().rpc[freshId]?.session.thinkingLevel ?? null)
    ) {
      await get().setThinkingLevel(freshId, options.thinkingLevel);
      if (get().rpc[freshId]?.failure?.command === "set_thinking_level") return;
    }
    const lead = "A plan was approved for this project. Implement it now.";
    const body = planSeedText(planText);
    const seed = body
      ? `${lead}\n\n${body}\n\nProceed with the implementation.`
      : lead;
    const accepted = await get().sendPrompt(
      freshId,
      withKeywords(
        withConcerns(seed, concerns),
        options ?? {},
      ),
      "prompt",
    );
    if (!accepted) return;

    handedOffPlanSources.add(srcTabId);
    advisorReplyWatcher.cancel(srcTabId);
    stallContinueWatcher.cancel(srcTabId);
    m.appendItem(
      srcTabId,
      noticeItem(
        "plan approved — implementation dispatched to a fresh session",
        "info",
      ),
    );
    try {
      await backend.hibernatePlanSource(srcTabId, freshId);
    } catch (err) {
      console.warn(
        `[plan-handoff] failed to hibernate source ${srcTabId} for implementation ${freshId}:`,
        err,
      );
    }
  };

  /**
   * Resolves the parameters every fresh session is spawned with: the default
   * mode plus the project's complete last-used advisor tuple.
   */
  const resolveSpawnParams = async (
    projectCwd: string,
  ): Promise<{
    mode: SessionMode;
    advisor: boolean;
    advisorModel: string | null;
  }> => {
    const mode = get().state?.defaultMode ?? "pty";
    // Carry the project's complete last-used advisor tuple into the new
    // session. Before any explicit choice, the app's own default decides;
    // omp's configured default only seeds while the app is not booted.
    await get().loadAdvisorDefaults(projectCwd);
    const defaults = get().advisorDefaults[projectCwd];
    const project = get().state?.projects.find(
      (g) => g.project.path === projectCwd,
    )?.project;
    // The pinned advisor model wins; on/off keeps its own chain (issue #257).
    const advisorModel =
      project?.defaultAdvisorModel ??
      project?.lastAdvisorModel ??
      defaults?.model ??
      null;
    const advisor =
      project?.lastAdvisor ??
      get().state?.defaultAdvisor ??
      defaults?.enabled ??
      false;
    return { mode, advisor, advisorModel };
  };

  const restartSession = async (tabId: string): Promise<boolean> => {
    const rec = findRecord(get().state, tabId);
    try {
      if (rec?.live === "live" && rec.mode === "rpc-ui")
        prepareRpcRelaunch(tabId);
      await backend.restartSession(tabId);
      return true;
    } catch (err) {
      alertError(err);
      return false;
    }
  };

  const addProject = async (path: string): Promise<void> => {
    await backend.addProject(path);
    set({ projectPickerOpen: false });
  };

  const setProjectDefaultModel = async (
    projectPath: string,
    model: string | null,
  ): Promise<void> => {
    await backend.setProjectDefaultModel(projectPath, model);
  };

  const setProjectDefaultAdvisorModel = async (
    projectPath: string,
    model: string | null,
  ): Promise<void> => {
    await backend.setProjectDefaultAdvisorModel(projectPath, model);
  };

  const removeProject = async (path: string): Promise<void> => {
    if (
      !window.confirm(
        `Remove project ${path} and its session records? Files on disk are kept.`,
      )
    )
      return;
    try {
      await backend.removeProject(path);
    } catch (err) {
      alertError(err);
    }
  };

  // No optimistic update: the `stateChanged` broadcast replaces `state`
  // authoritatively, exactly like removeProject.
  const moveProject = async (
    projectPath: string,
    beforePath: string | null,
  ): Promise<void> => {
    try {
      await backend.moveProject(projectPath, beforePath);
    } catch (err) {
      alertError(err);
    }
  };

  // No optimistic update: the `stateChanged` broadcast replaces `state`
  // authoritatively, exactly like moveProject.
  const moveSession = async (
    tabId: string,
    beforeTabId: string | null,
  ): Promise<void> => {
    try {
      await backend.moveSession(tabId, beforeTabId);
    } catch (err) {
      alertError(err);
    }
  };

  const toggleFavorite = async (key: string): Promise<void> => {
    await backend.toggleFavorite(key);
  };

  const newSession = async (
    projectCwd: string,
    modeOverride?: SessionMode,
  ): Promise<void> => {
    const { mode: defaultMode, advisor, advisorModel } =
      await resolveSpawnParams(projectCwd);
    const mode = modeOverride ?? defaultMode;
    try {
      const { tabId } = await backend.spawnSession({
        projectCwd,
        mode,
        advisor,
        advisorModel,
        cols: 80,
        rows: 24,
      });
      set((s) => ({
        tabs: [...s.tabs, { tabId, mode, projectCwd, hidden: false }],
        ...focusOn(s, tabId, projectCwd),
        exited: dropExited(s.exited, tabId),
      }));
    } catch (err) {
      alertError(err);
    }
  };

  const newWorktreeSession = async (
    projectCwd: string,
    opts: { branch: string; baseRef: string | null },
  ): Promise<void> => {
    const { mode, advisor, advisorModel } =
      await resolveSpawnParams(projectCwd);
    const { tabId } = await backend.spawnSession({
      projectCwd,
      mode,
      advisor,
      advisorModel,
      cols: 80,
      rows: 24,
      worktree: opts,
    });
    set((s) => ({
      tabs: [...s.tabs, { tabId, mode, projectCwd, hidden: false }],
      ...focusOn(s, tabId, projectCwd),
      exited: dropExited(s.exited, tabId),
    }));
  };

  /**
   * Converts an unprompted session to a worktree session (issue #225): the
   * main process mints the checkout, patches the record, and respawns in
   * place, and its broadcasts drive the state here — no tab churn. Throws
   * on failure; the composer renders the message inline.
   */
  const convertSessionToWorktree = async (
    tabId: string,
    opts: { branch: string; baseRef: string | null },
  ): Promise<void> => {
    await backend.convertToWorktree(tabId, opts.branch, opts.baseRef);
  };

  const openSession = async (tabId: string): Promise<void> => {
    const existing = get().tabs.find((t) => t.tabId === tabId);
    if (existing) {
      // Live session → resurface its tab, never respawn (omp has no
      // cross-process session lock; two writers would corrupt the .jsonl).
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.tabId === tabId ? { ...t, hidden: false } : t,
        ),
        ...focusOn(
          s,
          tabId,
          s.tabs.find((t) => t.tabId === tabId)?.projectCwd,
        ),
      }));
      return;
    }
    const rec = findRecord(get().state, tabId);
    if (!rec) return;
    try {
      await backend.spawnSession({
        projectCwd: rec.projectCwd,
        mode: rec.mode,
        advisor: rec.advisor,
        cols: 80,
        rows: 24,
        resumeTabId: tabId,
      });
      set((s) => ({
        tabs: [
          ...s.tabs,
          {
            tabId,
            mode: rec.mode,
            projectCwd: rec.projectCwd,
            hidden: false,
          },
        ],
        ...focusOn(s, tabId, rec.projectCwd),
        exited: dropExited(s.exited, tabId),
        hibernated: dropHibernated(s.hibernated, tabId),
      }));
    } catch (err) {
      alertError(err);
    }
  };

  const focusTab = (tabId: string): void => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.tabId === tabId ? { ...t, hidden: false } : t,
      ),
      ...focusOn(s, tabId, s.tabs.find((t) => t.tabId === tabId)?.projectCwd),
    }));
  };

  const hideTab = (tabId: string): void => {
    set((s) => {
      const tabs = s.tabs.map((t) =>
        t.tabId === tabId ? { ...t, hidden: true } : t,
      );
      let activeTabId = s.activeTabId;
      if (activeTabId === tabId) {
        const visible = tabs.filter((t) => !t.hidden);
        activeTabId =
          visible.length > 0 ? visible[visible.length - 1]!.tabId : null;
      }
      return {
        tabs,
        activeTabId,
        focusedTabByProject: forgetFocus(s.focusedTabByProject, tabId, tabs),
      };
    });
  };

  const terminate = async (tabId: string): Promise<void> => {
    if (
      !window.confirm(
        "Terminate the running agent? The session stays resumable.",
      )
    )
      return;
    await backend.terminateSession(tabId);
    // Terminating kills the drawer's program through killShell, which
    // deliberately suppresses its exit event — so nothing would ever retire
    // a staged handoff, and its banner would keep offering to send into a
    // dead PTY. Drop it here, as eraseSession does for the same reason.
    set((s) => ({ tuiHandoff: dropTuiHandoff(s.tuiHandoff, tabId) }));
  };

  const switchMode = async (tabId: string, mode: SessionMode): Promise<void> => {
    const rec = findRecord(get().state, tabId);
    if (rec?.live === "live") {
      const other = mode === "pty" ? "terminal" : "native";
      if (
        !window.confirm(
          `Restart this session in ${other} mode? The process is killed and resumed.`,
        )
      )
        return;
    }
    try {
      if (
        rec?.live === "live" &&
        rec.mode !== mode &&
        (rec.mode === "rpc-ui" || mode === "rpc-ui")
      ) {
        prepareRpcRelaunch(tabId);
      }
      await backend.switchMode(tabId, mode);
    } catch (err) {
      alertError(err);
    }
  };

  const resumeDead = async (tabId: string): Promise<void> => {
    const rec = findRecord(get().state, tabId);
    if (!rec) return;
    try {
      if (rec.mode === "rpc-ui") prepareRpcRelaunch(tabId);
      await backend.spawnSession({
        projectCwd: rec.projectCwd,
        mode: rec.mode,
        advisor: rec.advisor,
        cols: 80,
        rows: 24,
        resumeTabId: tabId,
      });
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.tabId === tabId ? { ...t, hidden: false } : t,
        ),
        ...focusOn(s, tabId, rec.projectCwd),
        exited: dropExited(s.exited, tabId),
        hibernated: dropHibernated(s.hibernated, tabId),
      }));
    } catch (err) {
      alertError(err);
    }
  };

  const deleteSession = async (tabId: string): Promise<void> => {
    const rec = findRecord(get().state, tabId);
    if (!rec) return;
    if (get().state?.skipDeleteConfirmation === true && !rec.worktree) {
      await eraseSession(tabId);
      return;
    }
    set({
      deleteConfirmation: {
        tabId,
        title: rec.title,
        running: rec.live === "live",
        hasFiles: rec.live !== "missing",
        worktreeBranch: rec.worktree?.branch ?? null,
        worktreeBase: rec.worktree?.base ?? null,
      },
    });
  };

  const confirmDeleteSession = async (skipFuture: boolean): Promise<void> => {
    const pending = get().deleteConfirmation;
    if (!pending) return;
    set({ deleteConfirmation: null });
    if (skipFuture) {
      try {
        await backend.setSkipDeleteConfirmation(true);
      } catch (err) {
        alertError(err);
      }
    }
    await eraseSession(pending.tabId);
  };

  const cancelDeleteSession = (): void => {
    set({ deleteConfirmation: null });
  };

  const clearShellExited = (tabId: string): void => {
    set((s) => ({ shellExited: dropExited(s.shellExited, tabId) }));
  };

  const toggleConsole = (tabId: string): void => {
    set((s) => ({
      consoleOpen: { ...s.consoleOpen, [tabId]: !s.consoleOpen[tabId] },
    }));
  };

  const openSearch = (tabId: string): void => {
    set((s) => ({
      searchOpen: { ...s.searchOpen, [tabId]: true },
    }));
  };

  const closeSearch = (tabId: string): void => {
    set((s) => ({
      searchOpen: { ...s.searchOpen, [tabId]: false },
    }));
  };

  const startTuiHandoff = (tabId: string, line: string): void => {
    set((s) => ({
      consoleOpen: { ...s.consoleOpen, [tabId]: true },
      // A previous shell's exit code would otherwise paint the drawer's
      // "exited" notice over the omp TUI about to replace it.
      shellExited: dropExited(s.shellExited, tabId),
      tuiHandoff: {
        ...s.tuiHandoff,
        [tabId]: {
          line,
          // The drawer respawns on a changed key, so staging a second
          // handoff into an open drawer restarts omp rather than typing
          // into whatever is already running there.
          key: (s.tuiHandoff[tabId]?.key ?? 0) + 1,
          phase: "running",
        },
      },
    }));
  };

  const sendTuiHandoff = (tabId: string): void => {
    const staged = get().tuiHandoff[tabId];
    if (staged?.phase !== "running") return;
    // CR, not LF: omp's TUI editor submits on carriage return — the same
    // byte xterm sends for Enter.
    backend.shellWrite(tabId, `${staged.line}\r`);
  };

  const dismissTuiHandoff = (tabId: string): void => {
    set((s) => ({ tuiHandoff: dropTuiHandoff(s.tuiHandoff, tabId) }));
  };

  return {
    shellExited: {},
    consoleOpen: {},
    searchOpen: {},
    tuiHandoff: {},
    deleteConfirmation: null,
    prepareRpcRelaunch,
    resolveSpawnParams,
    eraseSession,
    spawnFreshImplementation,
    restartSession,
    addProject,
    removeProject,
    moveProject,
    moveSession,
    setProjectDefaultModel,
    setProjectDefaultAdvisorModel,
    toggleFavorite,
    newSession,
    newWorktreeSession,
    convertSessionToWorktree,
    openSession,
    focusTab,
    hideTab,
    terminate,
    switchMode,
    resumeDead,
    deleteSession,
    confirmDeleteSession,
    cancelDeleteSession,
    clearShellExited,
    toggleConsole,
    openSearch,
    closeSearch,
    startTuiHandoff,
    sendTuiHandoff,
    dismissTuiHandoff,
  };
}
