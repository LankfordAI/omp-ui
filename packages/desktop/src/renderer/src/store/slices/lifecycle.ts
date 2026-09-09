// Session lifecycle domain (decomposed for #295): project and tab ops,
// spawn/resume/switch, delete confirmation, TUI handoff, and the
// console/search drawer toggles.
import type {
  DeleteSessionPreview,
  DeleteSessionResult,
  PlanImplementationSource,
  SessionMode,
  SessionWorktree,
  SpawnRequest,
  SpawnWorktree,
  WorktreeReleaseOptions,
  WorktreeReleaseResult,
  WorktreeSyncResult,
} from "@omp-ui/core/types";
import { backend, backendFor } from "../../backend";
import {
  withConcerns,
  withExecutionDestination,
  withKeywords,
  type PlanExecutionOptions,
} from "../../lib/plan-concerns";
import { planSeedText } from "../../lib/plan-seed";
import { noticeItem, settleRunningTools } from "../../lib/transcript";
import { t } from "../../lib/i18n";
import { randomId } from "../../lib/random-id";
import { projectKey } from "../../lib/project-key";
import {
  dropExited,
  dropHibernated,
  dropTuiHandoff,
  handedOffPlanSources,
  type GetState,
  type SetState,
  type StoreMachinery,
  type Watchers,
} from "./shared";
import { disposeTabRuntime } from "./rpc-command";
import { findInstance, findOwner, findRecord, focusOn, forgetFocus } from "./view";
import type {
  LifecycleConfirmation,
  LifecycleConfirmationChoice,
  UiStore,
} from "../types";

export type LifecycleSlice = Pick<
  UiStore,
  | "shellExited"
  | "consoleOpen"
  | "searchOpen"
  | "tuiHandoff"
  | "deleteConfirmation"
  | "lifecycleConfirmation"
  | "confirmLifecycleAction"
  | "cancelLifecycleAction"
  | "restartSession"
  | "addProject"
  | "removeProject"
  | "confirmRemoveRemoteInstance"
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
  | "releaseWorktreeSession"
  | "syncWorktreeSession"
  | "renameWorktreeSessionBranch"
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
  resolveSpawnParams(
    projectCwd: string,
    overrides?: {
      mode?: SessionMode;
      advisor?: boolean;
      advisorModel?: string | null;
    },
    instanceId?: string | null,
  ): Promise<{
    mode: SessionMode;
    advisor: boolean;
    advisorModel: string | null;
  }>;
  teardownProcess(tabId: string, code: number, hibernated?: boolean): void;
  /**
   * Forgets a tab the renderer can no longer address (issue #416): its
   * TabInfo, rpc slot, exit/hibernation marks, remembered focus, and runtime.
   * The record is untouched — the owning instance keeps or already lost it.
   */
  dropTab(tabId: string): void;
  eraseSession(tabId: string, cascade?: readonly string[]): Promise<boolean>;
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
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
  } = deps;

  const prepareRpcRelaunch = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    // A flush queued by the dying process must not land in the fresh state.
    m.cancelTranscriptBatch(tabId);
    m.patchRuntime(tabId, { compactionUsageGeneration: undefined });
    // No frames will come from the dying process: stop the stall clock now
    // rather than waiting for its next tick (issue #228).
    m.stopStreamStallTimer(tabId);
    // A fresh process has no wedge memory: re-arm the quiet-failure notice
    // and drop the attribution memory (issue #302) and the liveness clock
    // (issue #335). Pending waits are NOT abandoned here: this runs before
    // the process is killed, and setSessionAdvisor's drain (session-params)
    // depends on an unsettled loud command still being observable so it can
    // cancel the relaunch instead of losing the command. The waits die at
    // the real boundary — teardownProcess, or bootRpcTab when the fresh
    // process announces itself (issue #338).
    m.patchRuntime(tabId, {
      quietWedgeNotified: false,
      timedOutCommands: [],
      lastFrameAt: undefined,
    });
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

  /** One terminal boundary for both unexpected exit and idle hibernation. */
  const teardownProcess = (
    tabId: string,
    code: number,
    hibernated = false,
  ): void => {
    // An rpc-mode omp that dies mid-tool sends no agent_end or
    // omp_ui_error frame — this exit is the only signal, so running
    // tool cards are settled here (issue #93). Settle from the effective
    // items: a batched stream commit may still be pending, and the dead
    // process's final frames must not be lost (issue #187).
    const before = get().rpc[tabId];
    const settled = before
      ? settleRunningTools(m.effectiveItems(tabId), "aborted")
      : undefined;
    disposeTabRuntime(
      tabId,
      hibernated ? "the session was hibernated" : "the session process exited",
      deps,
      m,
    );
    set((s) => {
      // The stall field must clear even when no tool cards were running
      // — a pure-text stall settles to `settled === before.items`.
      const clearStall = before?.streamStallMs !== undefined;
      const rpc =
        before &&
        (clearStall || (settled !== undefined && settled !== before.items))
          ? {
              ...s.rpc,
              [tabId]: {
                ...before,
                ...(clearStall ? { streamStallMs: undefined } : {}),
                ...(settled !== undefined && settled !== before.items
                  ? { items: settled }
                  : {}),
              },
            }
          : s.rpc;
      return {
        exited: { ...s.exited, [tabId]: code },
        ...(hibernated
          ? { hibernated: { ...s.hibernated, [tabId]: true } }
          : {}),
        rpc,
      };
    });
  };

  /**
   * Forgets tabs in one commit: TabInfo, rpc slot, exit and hibernation
   * marks, staged TUI handoff, remembered focus, and the renderer runtime.
   * Active focus moves to the last visible survivor.
   */
  const dropTabs = (gone: readonly string[], reason: string): void => {
    for (const id of gone) {
      disposeTabRuntime(id, reason, deps, m);
      handedOffPlanSources.delete(id);
    }
    set((s) => {
      const rpc = { ...s.rpc };
      const tabs = s.tabs.filter((t) => !gone.includes(t.tabId));
      const activeTabId =
        s.activeTabId !== null && gone.includes(s.activeTabId)
          ? (tabs.filter((t) => !t.hidden).at(-1)?.tabId ?? null)
          : s.activeTabId;
      for (const id of gone) delete rpc[id];
      return {
        rpc,
        tabs,
        activeTabId,
        focusedTabByProject: gone.reduce(
          (focus, id) => forgetFocus(focus, id, tabs),
          s.focusedTabByProject,
        ),
        exited: gone.reduce((ex, id) => dropExited(ex, id), s.exited),
        hibernated: gone.reduce((hb, id) => dropHibernated(hb, id), s.hibernated),
        tuiHandoff: gone.reduce(
          (th, id) => dropTuiHandoff(th, id),
          s.tuiHandoff,
        ),
      };
    });
  };

  const dropTab = (tabId: string): void => {
    dropTabs([tabId], "the session is no longer reachable");
  };

  const eraseSession = async (
    tabId: string,
    cascade: readonly string[] = [],
  ): Promise<boolean> => {
    let result: DeleteSessionResult;
    try {
      result = await backend.deleteSession(tabId, cascade.length > 0);
    } catch (err) {
      get().reportError(err);
      return false;
    }
    if (result.failed.length > 0) {
      // The notice must not pause cleanup: successful members are erased
      // immediately below, and the failed records stay mounted and retryable.
      get().reportError(
        t("session.error.deletePartial", {
          failures: result.failed
            .map((failure) => `${failure.tabId}: ${failure.message}`)
            .join("\n"),
        }),
      );
    }
    if (result.deleted.length === 0) return false;
    dropTabs(result.deleted, "the session was deleted");
    return true;
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
    const owner = findOwner(get().state, srcTabId);
    if (!owner) return;
    const { instanceId, record: rec } = owner;
    const projectCwd = rec.projectCwd;
    // A "worktree" context dispatch carries its dedicated-checkout spec in
    // the options bag; every other context spawns in the project checkout
    // as-is.
    const minted = options?.worktree ?? null;
    // Reuse, not mint (issue #316): a fresh dispatch from a worktree
    // planning session keeps the planning checkout, and a worktree dispatch
    // that keeps the planning session's branch reuses that checkout in
    // place.
    const reuse: SessionWorktree | null =
      rec.worktree !== null &&
      (minted === null || minted.branch.trim() === rec.worktree.branch.trim())
        ? rec.worktree
        : null;
    // A staged tuple (the modal always sends one) wins over the project's
    // last-used defaults; legacy callers keep the fallback chain.
    const { advisor, advisorModel } = await resolveSpawnParams(
      projectCwd,
      options?.advisor !== undefined
        ? {
            mode: "rpc-ui",
            advisor: options.advisor,
            advisorModel: options.advisorModel ?? null,
          }
        : { mode: "rpc-ui" },
      instanceId,
    );
    const mode = "rpc-ui";
    const worktree: SpawnWorktree =
      reuse !== null
        ? { reuse }
        : minted !== null
          ? { mint: minted }
          : null;
    let freshId: string;
    try {
      ({ tabId: freshId } = await backendFor(instanceId).spawnSession({
        origin: "new",
        projectCwd,
        mode,
        advisor,
        advisorModel,
        cols: 80,
        rows: 24,
        planMode: false,
        planImplementationSource,
        worktree,
      }));
    } catch (err) {
      get().reportError(err);
      return;
    }
    set((s) => ({
      tabs: [
        ...s.tabs,
        { tabId: freshId, mode, projectCwd, hidden: false, instanceId },
      ],
      ...focusOn(s, freshId, projectKey(instanceId, projectCwd)),
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
        withExecutionDestination(
          withConcerns(seed, concerns),
          options?.destination,
        ),
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
        reuse !== null
          ? "plan approved — implementation dispatched to a fresh session in this worktree"
          : minted !== null
            ? "plan approved — implementation dispatched to a fresh worktree session"
            : "plan approved — implementation dispatched to a fresh session",
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
   * Resolves the single precedence chain used by every fresh spawn. The
   * project record read is the target instance's own (issue #416): a remote
   * project's last-used tuple lives in that instance's registry.
   */
  const resolveSpawnParams = async (
    projectCwd: string,
    overrides?: {
      mode?: SessionMode;
      advisor?: boolean;
      advisorModel?: string | null;
    },
    instanceId: string | null = null,
  ): Promise<{
    mode: SessionMode;
    advisor: boolean;
    advisorModel: string | null;
  }> => {
    const mode = overrides?.mode ?? get().state?.defaultMode ?? "pty";
    // Carry the project's complete last-used advisor tuple into the new
    // session. Before any explicit choice, the app's own default decides;
    // omp's configured default only seeds while the app is not booted.
    await get().loadAdvisorDefaults(projectCwd, instanceId);
    const defaults = get().advisorDefaults[projectKey(instanceId, projectCwd)];
    const project = projectGroups(instanceId)?.find(
      (g) => g.project.path === projectCwd,
    )?.project;
    const advisor =
      overrides?.advisor ??
      project?.lastAdvisor ??
      get().state?.defaultAdvisor ??
      defaults?.enabled ??
      false;
    // An explicit advisor tuple owns its model, including explicit null.
    // Otherwise the pinned project model wins its independent chain (#257).
    const advisorModel =
      overrides?.advisor !== undefined
        ? (overrides.advisorModel ?? null)
        : (project?.defaultAdvisorModel ??
          project?.lastAdvisorModel ??
          defaults?.model ??
          null);
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
      get().reportError(err);
      return false;
    }
  };

  /** The registry that owns a project path: local, or a joined instance's. */
  const projectGroups = (instanceId: string | null) =>
    instanceId === null
      ? get().state?.projects
      : findInstance(get().state, instanceId)?.projects;

  const addProject = async (
    path: string,
    instanceId: string | null = null,
  ): Promise<void> => {
    await backendFor(instanceId).addProject(path);
    set({ projectPickerOpen: false, projectPickerInstanceId: null });
  };

  const setProjectDefaultModel = async (
    projectPath: string,
    model: string | null,
    instanceId: string | null = null,
  ): Promise<void> => {
    await backendFor(instanceId).setProjectDefaultModel(projectPath, model);
  };

  const setProjectDefaultAdvisorModel = async (
    projectPath: string,
    model: string | null,
    instanceId: string | null = null,
  ): Promise<void> => {
    await backendFor(instanceId).setProjectDefaultAdvisorModel(projectPath, model);
  };

  const removeProject = async (
    path: string,
    instanceId: string | null = null,
  ): Promise<void> => {
    // Only a registered project has anything to confirm; removal itself
    // stays the backend's, and the authoritative stateChanged broadcast
    // drops the project from every renderer — no optimistic pruning here.
    const registered = projectGroups(instanceId)?.some(
      (group) => group.project.path === path,
    );
    if (!registered) return;
    stageLifecycleConfirmation({ kind: "remove-project", projectPath: path, instanceId });
  };

  const confirmRemoveRemoteInstance = (instanceId: string, nickname: string): void => {
    if (findInstance(get().state, instanceId) === undefined) return;
    stageLifecycleConfirmation({ kind: "remove-remote-instance", instanceId, nickname });
  };

  // No optimistic update: the `stateChanged` broadcast replaces `state`
  // authoritatively, exactly like removeProject.
  const moveProject = async (
    projectPath: string,
    beforePath: string | null,
    instanceId: string | null = null,
  ): Promise<void> => {
    try {
      await backendFor(instanceId).moveProject(projectPath, beforePath);
    } catch (err) {
      get().reportError(err);
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
      get().reportError(err);
    }
  };

  const toggleFavorite = async (key: string): Promise<void> => {
    await backend.toggleFavorite(key);
  };

  const newSession = async (
    projectCwd: string,
    modeOverride?: SessionMode,
    instanceId: string | null = null,
  ): Promise<void> => {
    const { mode, advisor, advisorModel } = await resolveSpawnParams(
      projectCwd,
      { mode: modeOverride },
      instanceId,
    );
    try {
      const request: SpawnRequest =
        mode === "pty"
          ? {
              origin: "new",
              projectCwd,
              mode: "pty",
              advisor,
              advisorModel,
              cols: 80,
              rows: 24,
              worktree: null,
            }
          : {
              origin: "new",
              projectCwd,
              mode: "rpc-ui",
              advisor,
              advisorModel,
              cols: 80,
              rows: 24,
              worktree: null,
            };
      const { tabId } = await backendFor(instanceId).spawnSession(request);
      set((s) => ({
        tabs: [...s.tabs, { tabId, mode, projectCwd, hidden: false, instanceId }],
        ...focusOn(s, tabId, projectKey(instanceId, projectCwd)),
        exited: dropExited(s.exited, tabId),
      }));
    } catch (err) {
      get().reportError(err);
    }
  };

  const newWorktreeSession = async (
    projectCwd: string,
    spec:
      | { mint: { branch: string; baseRef: string | null; baseBranch: string | null } }
      | { checkout: { branch: string } },
    instanceId: string | null = null,
  ): Promise<void> => {
    const { mode, advisor, advisorModel } =
      await resolveSpawnParams(projectCwd, undefined, instanceId);
    const request: SpawnRequest =
      mode === "pty"
        ? {
            origin: "new",
            projectCwd,
            mode: "pty",
            advisor,
            advisorModel,
            cols: 80,
            rows: 24,
            worktree: spec,
          }
        : {
            origin: "new",
            projectCwd,
            mode: "rpc-ui",
            advisor,
            advisorModel,
            cols: 80,
            rows: 24,
            worktree: spec,
          };
    const { tabId } = await backendFor(instanceId).spawnSession(request);
    // Issue #405: the create operation may have just minted a base branch.
    // Surface it in the lists without a network round trip (mirrors the
    // branches slice's createBranch).
    if ("mint" in spec && spec.mint.baseBranch !== null) {
      void get().refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
    }
    set((s) => ({
      tabs: [...s.tabs, { tabId, mode, projectCwd, hidden: false, instanceId }],
      ...focusOn(s, tabId, projectKey(instanceId, projectCwd)),
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
    opts: { branch: string; baseRef: string | null; baseBranch: string | null },
  ): Promise<void> => {
    const owner = findOwner(get().state, tabId);
    await backend.convertToWorktree(tabId, opts.branch, opts.baseRef, opts.baseBranch);
    // Issue #405: a new base branch created by the convert shows up in the
    // lists locally, same as the spawn path above.
    if (opts.baseBranch !== null && owner !== undefined) {
      void get().refreshBranches(
        owner.record.projectCwd,
        { fetchUpstream: false },
        owner.instanceId,
      );
    }
  };

  /**
   * Resurfaces or resumes a session's tab. A tab-scoped resume rides the
   * local backend: main routes it to the owning instance by resumeTabId. An
   * instance that is not joined cannot resume anything, so the attempt is
   * refused up front instead of surfacing the proxy's rejection (issue #416).
   */
  const openSession = async (tabId: string): Promise<void> => {
    const existing = get().tabs.find((t) => t.tabId === tabId);
    if (existing) {
      // Live session → resurface its tab, never respawn (omp has no
      // cross-process session lock; two writers would corrupt the .jsonl).
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.tabId === tabId ? { ...t, hidden: false } : t,
        ),
        ...focusOn(s, tabId, projectKey(existing.instanceId, existing.projectCwd)),
      }));
      return;
    }
    const owner = findOwner(get().state, tabId);
    if (!owner) return;
    const { instanceId, record: rec } = owner;
    const instance = findInstance(get().state, instanceId);
    if (instance !== undefined && instance.status !== "joined") {
      get().reportError(
        new Error(t("remoteinstances.error.notJoined", { nickname: instance.nickname })),
      );
      return;
    }
    try {
      await backend.spawnSession({
        origin: "resume",
        resumeTabId: tabId,
        cols: 80,
        rows: 24,
      });
      set((s) => ({
        tabs: [
          ...s.tabs,
          {
            tabId,
            mode: rec.mode,
            projectCwd: rec.projectCwd,
            hidden: false,
            instanceId,
          },
        ],
        ...focusOn(s, tabId, projectKey(instanceId, rec.projectCwd)),
        exited: dropExited(s.exited, tabId),
        hibernated: dropHibernated(s.hibernated, tabId),
      }));
    } catch (err) {
      get().reportError(err);
    }
  };

  const focusTab = (tabId: string): void => {
    set((s) => {
      const tab = s.tabs.find((t) => t.tabId === tabId);
      return {
        tabs: s.tabs.map((t) =>
          t.tabId === tabId ? { ...t, hidden: false } : t,
        ),
        ...focusOn(s, tabId, tab && projectKey(tab.instanceId, tab.projectCwd)),
      };
    });
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

  /**
   * Stages one lifecycle decision (issue #373). A confirmation never
   * overwrites a pending lifecycle confirmation or a visible delete
   * confirmation, and repeated invocations while one is pending are no-ops:
   * there is no queue of destructive decisions.
   */
  const stageLifecycleConfirmation = (
    choice: LifecycleConfirmationChoice,
  ): void => {
    const s = get();
    if (s.lifecycleConfirmation !== null || s.deleteConfirmation !== null) return;
    set({ lifecycleConfirmation: { ...choice, id: randomId(), busy: false } });
  };

  /**
   * The accepted effect behind `confirmLifecycleAction`. Targets are
   * re-checked against current backend state — never the record captured at
   * staging — so a vanished or already-changed subject dismisses harmlessly.
   * Rejections propagate to the caller's reportError catch.
   */
  const runLifecycleConfirmation = async (
    confirmation: LifecycleConfirmation,
  ): Promise<void> => {
    if (confirmation.kind === "terminate") {
      const rec = findRecord(get().state, confirmation.tabId);
      if (!rec || rec.live !== "live") return;
      await backend.terminateSession(confirmation.tabId);
      // Only a successful stop retires the handoff: killShell suppresses the
      // drawer program's exit event, so a discarded handoff after a failed
      // termination would silently strand its banner over a still-live PTY —
      // and a rejection is not the stop the user accepted.
      set((s) => ({ tuiHandoff: dropTuiHandoff(s.tuiHandoff, confirmation.tabId) }));
      return;
    }
    if (confirmation.kind === "switch-mode") {
      const rec = findRecord(get().state, confirmation.tabId);
      // Stale when another switch already moved the mode. A session that
      // merely died meanwhile keeps its requested change: no restart is
      // prepared, and the dormant path switches in place.
      if (!rec || rec.mode !== confirmation.fromMode) return;
      await performSwitchMode(confirmation.tabId, confirmation.mode);
      return;
    }
    if (confirmation.kind === "remove-remote-instance") {
      // Already forgotten meanwhile (another renderer, or the instance's
      // own removal): nothing to send.
      if (findInstance(get().state, confirmation.instanceId) === undefined) return;
      await backend.removeRemoteInstance(confirmation.instanceId);
      return;
    }
    const registered = projectGroups(confirmation.instanceId)?.some(
      (group) => group.project.path === confirmation.projectPath,
    );
    if (!registered) return;
    await backendFor(confirmation.instanceId).removeProject(confirmation.projectPath);
  };

  const confirmLifecycleAction = async (id: string): Promise<void> => {
    const pending = get().lifecycleConfirmation;
    // Ids are single-use: a second activation while busy, or on a replaced or
    // already-settled confirmation, dispatches nothing.
    if (!pending || pending.id !== id || pending.busy) return;
    // Busy lands synchronously before the first await.
    set({ lifecycleConfirmation: { ...pending, busy: true } });
    try {
      await runLifecycleConfirmation(pending);
    } catch (err) {
      get().reportError(err);
    } finally {
      // Clear only this confirmation — a newer one (impossible while busy,
      // defensive anyway) must never be dropped by an older settlement.
      set((s) =>
        s.lifecycleConfirmation?.id === id ? { lifecycleConfirmation: null } : s,
      );
    }
  };

  const cancelLifecycleAction = (id: string): void => {
    const pending = get().lifecycleConfirmation;
    if (!pending || pending.id !== id || pending.busy) return;
    set({ lifecycleConfirmation: null });
  };

  const terminate = async (tabId: string): Promise<void> => {
    // Stopping is a live-session action: no record or no live process means
    // there is nothing to confirm, and no DOM dialog is staged.
    const rec = findRecord(get().state, tabId);
    if (!rec || rec.live !== "live") return;
    stageLifecycleConfirmation({ kind: "terminate", tabId, title: rec.title });
  };

  const switchMode = async (tabId: string, mode: SessionMode): Promise<void> => {
    const rec = findRecord(get().state, tabId);
    // Absent record or an already-selected mode: no action, no prompt.
    if (!rec || rec.mode === mode) return;
    // Only a running process is killed and resumed; a dormant selection
    // switches without a restart prompt, exactly as before.
    if (rec.live === "live") {
      stageLifecycleConfirmation({
        kind: "switch-mode",
        tabId,
        title: rec.title,
        fromMode: rec.mode,
        mode,
      });
      return;
    }
    await performSwitchMode(tabId, mode);
  };

  /**
   * The shared mode-switch effect: preparation and backend call, re-reading
   * the record first. RPC state is prepared only when this runs — which is
   * never before an approval.
   */
  const performSwitchMode = async (
    tabId: string,
    mode: SessionMode,
  ): Promise<void> => {
    const rec = findRecord(get().state, tabId);
    if (!rec) return;
    try {
      if (
        rec.live === "live" &&
        rec.mode !== mode &&
        (rec.mode === "rpc-ui" || mode === "rpc-ui")
      ) {
        prepareRpcRelaunch(tabId);
      }
      await backend.switchMode(tabId, mode);
    } catch (err) {
      get().reportError(err);
    }
  };

  const resumeDead = async (tabId: string): Promise<void> => {
    const owner = findOwner(get().state, tabId);
    if (!owner) return;
    const { instanceId, record: rec } = owner;
    try {
      if (rec.mode === "rpc-ui") prepareRpcRelaunch(tabId);
      await backend.spawnSession({
        origin: "resume",
        resumeTabId: tabId,
        cols: 80,
        rows: 24,
      });
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.tabId === tabId ? { ...t, hidden: false } : t,
        ),
        ...focusOn(s, tabId, projectKey(instanceId, rec.projectCwd)),
        exited: dropExited(s.exited, tabId),
        hibernated: dropHibernated(s.hibernated, tabId),
      }));
    } catch (err) {
      get().reportError(err);
    }
  };

  const deleteSession = async (tabId: string): Promise<void> => {
    const rec = findRecord(get().state, tabId);
    if (!rec) return;
    let preview: DeleteSessionPreview;
    try {
      preview = await backend.deleteSessionPreview(tabId);
    } catch (err) {
      get().reportError(err);
      return;
    }
    const cascade = preview.descendants;
    if (
      get().state?.skipDeleteConfirmation === true &&
      !rec.worktree &&
      cascade.length === 0
    ) {
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
        worktreePath: rec.worktree?.path ?? null,
        cascade,
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
        get().reportError(err);
      }
    }
    await eraseSession(pending.tabId, pending.cascade.map((d) => d.tabId));
  };

  /**
   * Returns a worktree session to its project checkout after its merge-back
   * (issue #334). Main nulls the record's worktree, reclaims the checkout and
   * branch, and respawns in place; its broadcast drives the state here — no tab
   * churn, no teardown. Resolves to the outcome so the caller can name what
   * happened to the checkout and branch, or null when main rejected and the
   * session is still a worktree session.
   */
  const releaseWorktreeSession = async (
    tabId: string,
    opts: WorktreeReleaseOptions,
  ): Promise<WorktreeReleaseResult | null> => {
    const rec = findRecord(get().state, tabId);
    try {
      if (rec?.live === "live" && rec.mode === "rpc-ui") prepareRpcRelaunch(tabId);
      const answered = await backend.releaseWorktree(tabId, opts);
      // checkoutSwitch is required of a local main process; an older remote
      // instance answers without it, so it is normalized at the seam exactly
      // as spawn-request.ts:113 normalizes a missing mint.baseBranch (#416).
      const release = {
        ...answered,
        checkoutSwitch: answered.checkoutSwitch ?? { kind: "none" as const },
      };
      // The release moved the project checkout's branch (#431), so the cached
      // listing is stale: same local-refs refresh a branch switch does.
      if (release.checkoutSwitch.kind === "switched") {
        const owner = findOwner(get().state, tabId);
        if (owner) {
          await get().refreshBranches(
            owner.record.projectCwd,
            { fetchUpstream: false },
            owner.instanceId,
          );
        }
      }
      return release;
    } catch (err) {
      get().reportError(err);
      return null;
    }
  };

  /**
   * Merges `source` into the session's worktree checkout (issue #387). The
   * relaunch-prep is the same guard as release: main serialises the merge
   * against the tab's other lifecycle ops without respawning anything.
   */
  const syncWorktreeSession = async (
    tabId: string,
    source: string,
  ): Promise<WorktreeSyncResult | null> => {
    try {
      return await backend.syncWorktree(tabId, source);
    } catch (err) {
      get().reportError(err);
      return null;
    }
  };

  /**
   * Renames the branch a worktree session runs on (issues #386, #389): main
   * moves the ref and the record; the broadcast refreshes every reader.
   */
  const renameWorktreeSessionBranch = async (
    tabId: string,
    newName: string,
  ): Promise<boolean> => {
    try {
      await backend.renameWorktreeBranch(tabId, newName);
      return true;
    } catch (err) {
      get().reportError(err);
      return false;
    }
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
    lifecycleConfirmation: null,
    confirmLifecycleAction,
    cancelLifecycleAction,
    prepareRpcRelaunch,
    resolveSpawnParams,
    teardownProcess,
    dropTab,
    eraseSession,
    spawnFreshImplementation,
    restartSession,
    addProject,
    removeProject,
    confirmRemoveRemoteInstance,
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
    releaseWorktreeSession,
    syncWorktreeSession,
    renameWorktreeSessionBranch,
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
