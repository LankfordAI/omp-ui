// Session lifecycle domain (decomposed for #295): project and tab ops,
// spawn/resume/switch, delete confirmation, TUI handoff, and the
// console/search drawer toggles.
import type {
  DeleteSessionPreview,
  DeleteSessionResult,
  KnowledgeHome,
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
  composeImplementationPrompt,
  type PlanExecutionOptions,
} from "../../lib/plan-concerns";
import { gitResolutionPrompt, type GitResolutionTrigger } from "../../lib/git-resolution-prompt";
import { worktreeMergeResolutionState } from "../../lib/worktree-merge-resolution";
import { liveAudioLocalToClient, supportsNativeLive } from "../../lib/live-voice";
import { planSeedInfo, planSeedText } from "../../lib/plan-seed";
import { composeCarryoverContext } from "../../lib/carryover-context";
import { noticeItem, settleRunningItems, type AdvisorNote } from "../../lib/transcript";
import { t } from "../../lib/i18n";
import { randomId } from "../../lib/random-id";
import { projectKey } from "../../lib/project-key";
import {
  dropExited,
  dropHibernated,
  dropLiveVoiceBadge,
  dropTuiHandoff,
  peekTabRuntime,
  type GetState,
  type SetState,
  type StoreMachinery,
  type Watchers,
} from "./shared";
import { disposeTabRuntime } from "./rpc-command";
import { liveVoiceGeneration } from "./live-work-park";
import { findInstance, findOwner, findRecord, findWorktreeAt, focusOn, forgetFocus } from "./view";
import type {
  DeleteConfirmation,
  LifecycleConfirmation,
  LifecycleConfirmationChoice,
  UiStore,
} from "../types";

/**
 * `ipcRenderer.invoke` never times out on its own, so a main-process spawn
 * that stalls would leave every new-session entry point silently pending
 * forever (issue #789). The renderer bounds the wait; a spawn that settles
 * after the notice still lands its tab exactly once.
 */
const SPAWN_SETTLE_MS = 30_000;

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
  | "createSidebarGroup"
  | "renameSidebarGroup"
  | "removeSidebarGroup"
  | "moveSidebarGroup"
  | "setSidebarGroupCollapsed"
  | "setProjectSidebarGroup"
  | "moveSession"
  | "setProjectDefaultModel"
  | "setProjectDefaultAdvisorModel"
  | "setProjectBrowserClock"
  | "setProjectKnowledgeHome"
  | "vaultNames"
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
  | "resumeWithModel"
  | "deleteSession"
  | "confirmDeleteSession"
  | "releaseWorktreeSession"
  | "syncWorktreeSession"
  | "renameWorktreeSessionBranch"
  | "resolveWorktreeMerge"
  | "cancelDeleteSession"
  | "clearShellExited"
  | "toggleConsole"
  | "openSearch"
  | "closeSearch"
  | "startTuiHandoff"
  | "sendTuiHandoff"
  | "dismissTuiHandoff"
> & {
  /** Stages one pending session decision; any slice may ask for it. */
  stageLifecycleConfirmation(choice: LifecycleConfirmationChoice): void;
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
    concerns: readonly AdvisorNote[],
    options?: PlanExecutionOptions,
  ): Promise<void>;
  spawnGitResolution(
    projectCwd: string,
    trigger: GitResolutionTrigger,
    instanceId?: string | null,
  ): Promise<boolean>;
};

export type LifecycleDeps = Watchers;

/**
 * Whether the skip-confirmation setting covers this delete (issue #641).
 * The store erases a covered delete without staging the dialog, and the
 * dialog offers its opt-out only on covered deletes — ticking it could not
 * suppress any other. A delete that removes a worktree checkout, the
 * session's own or a plan-handoff descendant's, always asks: the checkout
 * is force-removed with its uncommitted changes (ADR-0018, ADR-0021).
 * `=== false`, not falsy: a remote instance on an older build omits the
 * flag, and an unknown descendant is never erased unasked.
 */
export function skipConfirmationCovers(
  confirmation: Pick<DeleteConfirmation, "worktreePath" | "cascade">,
): boolean {
  return (
    confirmation.worktreePath === null &&
    confirmation.cascade.every((descendant) => descendant.worktree === false)
  );
}

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
      pendingTurnKeywords: [],
      keywordInputBatchStarted: false,
    });
    m.patchRpc(tabId, {
      status: "starting",
      commandAdmissionBlocked: false,
      plan: null,
      session: { ...tab.session, isStreaming: false },
      extensionQueue: [],
      experimentProposal: null,
      approvalPrompt: null,
      failure: undefined,
      // A fresh process has no renderer-observed checkpoint: resetting it
      // also stops the #100 notice from citing the dead process's
      // "since turn started" (issue #228, #179).
      streamCheckpoint: undefined,
      streamStallMs: undefined,
      activeTurnKeywords: [],
    });
    get().clearPlanReview(tabId);
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
      ? settleRunningItems(m.effectiveItems(tabId), "aborted")
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
      const clearKeywords = (before?.activeTurnKeywords.length ?? 0) > 0;
      const rpc =
        before &&
        (clearStall || clearKeywords || (settled !== undefined && settled !== before.items))
          ? {
              ...s.rpc,
              [tabId]: {
                ...(s.rpc[tabId] ?? before),
                ...(clearStall ? { streamStallMs: undefined } : {}),
                ...(clearKeywords ? { activeTurnKeywords: [] } : {}),
                ...(settled !== undefined && settled !== before.items
                  ? { items: settled }
                  : {}),
              },
            }
          : s.rpc;
      // The park/resume badge is the dying process's (#811): a ghost glyph on
      // a tab whose runtime is gone would promise a resume that cannot fire.
      const liveVoice = dropLiveVoiceBadge(s.liveVoice, tabId);
      return {
        exited: { ...s.exited, [tabId]: code },
        liveVoice,
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
        liveVoice: gone.reduce((badge, id) => dropLiveVoiceBadge(badge, id), s.liveVoice),
        hibernated: gone.reduce((hb, id) => dropHibernated(hb, id), s.hibernated),
        tuiHandoff: gone.reduce(
          (th, id) => dropTuiHandoff(th, id),
          s.tuiHandoff,
        ),
        // Live-share state is the dying process's (issue #686): its registry
        // row dies with it, and a stale sharing chip must not haunt a future
        // tab id. The dialog closes with the tab it described.
        collab: gone.reduce(
          (shares, id) => {
            if (shares[id] === undefined) return shares;
            const next = { ...shares };
            delete next[id];
            return next;
          },
          s.collab,
        ),
        ...(s.shareLiveTab !== null && gone.includes(s.shareLiveTab)
          ? { shareLiveTab: null }
          : {}),
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
    concerns: readonly AdvisorNote[] = [],
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
    await m.pollUntilSettled(freshId);
    if (get().rpc[freshId]?.status !== "ready") {
      // An errored boot owns a failure banner and an exited one owns an
      // exit notice; a boot that simply never reported is the one abort
      // with no observable symptom anywhere — #622 hid behind exactly
      // this silence, so it says so on the planning session instead.
      if (
        get().rpc[freshId]?.status !== "error" &&
        get().exited[freshId] === undefined
      ) {
        m.appendItem(
          srcTabId,
          noticeItem(
            "implementation not dispatched — the fresh session never finished starting; open it and send the plan manually",
            "warn",
          ),
        );
      }
      return;
    }
    // Staged parameters share one failure policy across every fresh launch.
    if (!(await m.applyStagedParams(freshId, options ?? {}))) return;
    const lead = "A plan was approved for this project. Implement it now.";
    const body = planSeedText(planText);
    const seed = composeImplementationPrompt({
      lead,
      plan: body === null ? null : { body, info: planSeedInfo(planText!) },
      concerns,
      options,
    });
    const accepted = await get().sendPrompt(freshId, seed, "prompt");
    if (!accepted) return;

    set((state) => ({
      handedOffFor: { ...state.handedOffFor, [srcTabId]: freshId },
      observedPlanHandoffs: {
        ...state.observedPlanHandoffs,
        [srcTabId]: freshId,
      },
    }));
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
    // Voice follows only the viewed implementation and the source runtime that
    // still owns the user's armed intent. Capability discovery and live_stop
    // can outlive navigation, an explicit stop, or a replacement source call.
    const srcRt = peekTabRuntime(srcTabId);
    const sourceGeneration = liveVoiceGeneration(srcTabId);
    const sourceIntendsVoice = (): boolean => {
      const live = get().rpc[srcTabId]?.live;
      if (srcRt === undefined || peekTabRuntime(srcTabId) !== srcRt ||
        live?.phase === "error" || live?.error != null) return false;
      if (srcRt.liveVoiceOwner === true) {
        return srcRt.liveArmed === true || (live != null && !live.ended);
      }
      // #816: a client that is not the session host can never own or arm a
      // call, so an open source snapshot is the host's microphone and the
      // handoff still releases it (stopLiveVoice is version-gated, never
      // hardware-gated; the destination start no-ops at the store gate).
      // A second Electron view of a locally owned call never lands here —
      // it must not steal the other view's call (#821).
      return live != null && !live.ended &&
        !liveAudioLocalToClient(findOwner(get().state, srcTabId)?.instanceId ?? null);
    };
    const destinationViewed = (): boolean => get().activeTabId === freshId &&
      get().tabs.some((tab) => tab.tabId === freshId && !tab.hidden) &&
      get().exited[freshId] === undefined;
    if (sourceIntendsVoice() && destinationViewed()) {
      // startLiveVoice's supportsNativeLive gate reads the DESTINATION's
      // capabilities, which boot publishes shortly after ready; waiting keeps
      // a not-yet-published roster from silently no-op'ing the start after the
      // source was already stopped.
      await m.pollUntil(
        freshId,
        (rpc) => supportsNativeLive(rpc?.capabilities?.ompVersion ?? null),
        5_000,
      );
      if (
        supportsNativeLive(get().rpc[freshId]?.capabilities?.ompVersion ?? null) &&
        destinationViewed() && sourceIntendsVoice() &&
        liveVoiceGeneration(srcTabId) === sourceGeneration
      ) {
        // An already-pending park owns the same stop acknowledgment. Explicit
        // stop disarms the source, but must not treat that pending stop as done.
        const pendingStop = srcRt!.liveStopInFlight;
        const stopping = get().stopLiveVoice(srcTabId);
        const stopGeneration = liveVoiceGeneration(srcTabId);
        await stopping;
        if (pendingStop !== undefined) await pendingStop.catch(() => null);
        // A wake that raced the stop's generation bump can hold an unacked
        // live_start on the source (live_start rides off-chain). Wait for its
        // outcome rather than refusing on it: an abandoned start must not
        // strand the destination's voice (#822). A start that SUCCEEDED after
        // the stop leaves an open source call, and its closing stop ack ends it.
        const racingStart = srcRt!.liveStartInFlight;
        if (racingStart !== undefined) await racingStart.catch(() => null);
        const closingStop = srcRt!.liveStopInFlight;
        if (closingStop !== undefined) await closingStop.catch(() => null);
        const stopped = get().rpc[srcTabId]?.live;
        // The gate is that no source call stays OPEN, not that it ended
        // cleanly: a wake that raced the handoff ends in a transport-teardown
        // error once the source hibernates, and pinning error-free here would
        // strand the destination's voice forever (#822).
        if (
          peekTabRuntime(srcTabId) === srcRt &&
          liveVoiceGeneration(srcTabId) === stopGeneration &&
          srcRt!.liveArmed !== true && srcRt!.liveStartInFlight === undefined &&
          (stopped == null || stopped.ended) &&
          destinationViewed()
        ) void get().startLiveVoice(freshId);
      }
    }
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
   * Issue #675: the branch chip's resolve row. Spawns one fresh rpc-ui
   * session in the checkout the chip shows — reusing the registered
   * worktree when that path is a session's checkout, never minting a new
   * one — and seeds it with the resolution playbook once it reports ready.
   */
  const spawnGitResolution = async (
    projectCwd: string,
    trigger: GitResolutionTrigger,
    instanceId?: string | null,
    finishGuard?: { check: () => boolean },
  ): Promise<boolean> => {
    const spawnInstanceId = instanceId ?? null;
    const state = get().state;
    // A path is meaningful only on its explicitly addressed host. Scope the
    // lookup before searching, since identical checkout paths are common.
    const scoped = state === null ? null : spawnInstanceId === null
      ? { ...state, remoteInstances: [] }
      : { ...state, projects: [], remoteInstances: state.remoteInstances.filter((instance) => instance.id === spawnInstanceId) };
    const owner = finishGuard === undefined ? findWorktreeAt(scoped, trigger.cwd) : null;
    const spawnProjectCwd = owner?.projectCwd ?? projectCwd;
    const worktree: SpawnWorktree = owner !== null ? { reuse: owner.worktree } : null;
    let freshId: string;
    try {
      const { advisor, advisorModel } = await resolveSpawnParams(
        spawnProjectCwd,
        { mode: "rpc-ui" },
        spawnInstanceId,
      );
      if (finishGuard && !finishGuard.check()) return false;
      ({ tabId: freshId } = await backendFor(spawnInstanceId).spawnSession({
        origin: "new",
        projectCwd: spawnProjectCwd,
        mode: "rpc-ui",
        advisor,
        advisorModel,
        cols: 80,
        rows: 24,
        planMode: false,
        worktree,
      }));
    } catch (err) {
      get().reportError(err); // the branch chip has no dialog to render it inline
      return false;
    }
    set((s) => ({
      tabs: [
        ...s.tabs,
        { tabId: freshId, mode: "rpc-ui", projectCwd: spawnProjectCwd, hidden: false, instanceId: spawnInstanceId },
      ],
      ...focusOn(s, freshId, projectKey(spawnInstanceId, spawnProjectCwd)),
      exited: dropExited(s.exited, freshId),
    }));
    await m.pollUntilSettled(freshId);
    // The ready frame can precede the renderer's boot commands. Do not mistake
    // that transient command activity for a rejected resolution seed.
    if (get().rpc[freshId]?.status === "ready" && get().rpc[freshId]?.busy) {
      await m.pollUntil(freshId, (rpc) =>
        get().exited[freshId] !== undefined || rpc?.status === "error" ||
        (rpc?.status === "ready" && !rpc.busy));
    }
    const fresh = get().rpc[freshId];
    if (fresh?.status !== "ready" || get().exited[freshId] !== undefined) {
      // An errored boot owns a failure banner and an exited one owns an
      // exit notice; a boot that simply never reported is the silence #622
      // hides behind — say so rather than prompt into the void.
      if (fresh?.status !== "error" && get().exited[freshId] === undefined) {
        get().reportError(
          new Error(
            "the resolution session never finished starting — open a session in the checkout and resolve manually",
          ),
        );
      }
      return false;
    }
    const freshOwner = findOwner(get().state, freshId);
    if (
      (finishGuard && !finishGuard.check()) || !m.acceptsCommands(freshId) ||
      fresh.busy || fresh.compacting !== undefined || fresh.session.isStreaming ||
      fresh.session.isCompacting || fresh.session.queuedMessageCount > 0 ||
      fresh.plan?.enabled === true || fresh.planReview !== null ||
      fresh.approvalPrompt !== null || fresh.experimentProposal !== null ||
      fresh.extensionQueue.length > 0 || freshOwner?.record.pendingPlan != null ||
      freshOwner?.record.awaitingHumanAnswer === true ||
      (freshOwner !== undefined && (freshOwner.instanceId !== spawnInstanceId ||
        freshOwner.record.projectCwd !== spawnProjectCwd ||
        (finishGuard !== undefined && freshOwner.record.worktree !== null)))
    ) {
      m.appendItem(freshId, noticeItem(t("finish.resolution.failed"), "warn"));
      return false;
    }
    let accepted = false;
    try {
      accepted = await get().sendPrompt(freshId, gitResolutionPrompt(trigger), "prompt");
    } catch (err) {
      get().reportError(err);
    }
    if (!accepted) m.appendItem(freshId, noticeItem(t("finish.resolution.failed"), "warn"));
    return accepted;
  };

  const resolveWorktreeMerge = async (
    tabId: string,
    trigger: Extract<GitResolutionTrigger, { kind: "merge" }>,
    route: "current" | "fresh",
  ): Promise<boolean> => {
    const original = findOwner(get().state, tabId);
    if (!original?.record.worktree || trigger.cwd !== original.record.projectCwd) {
      get().reportError(t("finish.resolution.stale"));
      return false;
    }
    const { record, instanceId } = original;
    const worktree = original.record.worktree;
    const unchanged = (): boolean => {
      const owner = findOwner(get().state, tabId);
      return owner !== undefined && owner.instanceId === instanceId &&
        owner.record.sessionId === record.sessionId && owner.record.lineageDir === record.lineageDir &&
        owner.record.launchedAt === record.launchedAt && owner.record.projectCwd === record.projectCwd &&
        owner.record.mode === record.mode && owner.record.worktree != null &&
        owner.record.worktree.path === worktree.path && owner.record.worktree.branch === worktree.branch &&
        owner.record.worktree.base === worktree.base;
    };
    const safe = (): boolean => {
      const resolution = worktreeMergeResolutionState(get(), tabId);
      if (!unchanged() || resolution?.route !== route) {
        get().reportError(t("finish.resolution.stale"));
        return false;
      }
      if (resolution.blockedReason !== null) {
        get().reportError(resolution.blockedReason);
        return false;
      }
      return true;
    };
    if (!safe()) return false;
    if (route === "fresh") {
      return spawnGitResolution(record.projectCwd, trigger, instanceId, { check: safe });
    }
    const priorPlan = get().rpc[tabId]?.plan;
    const requiredBuildAck = priorPlan?.enabled === true || record.agentMode === "plan";
    if (requiredBuildAck) {
      // A replayed Build snapshot can disagree with the owning record. Require
      // a fresh publication after exit; never settle or defer a review gate.
      void get().setPlanMode(tabId, false).catch((err: unknown) => get().reportError(err));
      await m.pollUntil(tabId, (rpc) =>
        get().exited[tabId] !== undefined || !unchanged() ||
        findOwner(get().state, tabId)?.record.live !== "live" ||
        (rpc?.plan?.enabled === false && rpc.plan !== priorPlan && !rpc.busy), 5_000);
    }
    if (!safe()) return false;
    if (!m.acceptsCommands(tabId) || get().rpc[tabId]?.plan?.enabled === true ||
      (requiredBuildAck && (get().rpc[tabId]?.plan?.enabled !== false || get().rpc[tabId]?.plan === priorPlan))) {
      get().reportError(t("finish.resolution.failed"));
      return false;
    }
    try {
      const accepted = await get().sendPrompt(tabId, gitResolutionPrompt(trigger), "prompt");
      if (accepted) get().focusTab(tabId);
      return accepted;
    } catch (err) {
      get().reportError(err);
      return false;
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
      // The #824 seed must be captured before the relaunch preparation:
      // the successor's bootRpcTab wipes items when it announces itself.
      const digest =
        rec?.mode === "rpc-ui" ? composeCarryoverContext(m.effectiveItems(tabId)) : null;
      if (rec?.live === "live" && rec.mode === "rpc-ui")
        prepareRpcRelaunch(tabId);
      // "" is the channel's "no seed"; the codec is a plain trailing string.
      await backend.restartSession(tabId, digest ?? "");
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

  const setProjectBrowserClock = async (
    projectPath: string,
    on: boolean,
    instanceId: string | null = null,
  ): Promise<void> => {
    await backendFor(instanceId).setProjectBrowserClock(projectPath, on);
  };

  const setProjectKnowledgeHome = async (
    projectPath: string,
    home: KnowledgeHome | null,
    instanceId: string | null = null,
  ): Promise<void> => {
    await backendFor(instanceId).setProjectKnowledgeHome(projectPath, home);
  };

  const vaultNames = (instanceId: string | null = null): Promise<string[]> =>
    backendFor(instanceId).vaultNames();

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

  // Sidebar groups (issue #745) live on this computer's registry only, so
  // these always use the local `backend`, never `backendFor`. No optimistic
  // update: the `stateChanged` broadcast replaces `state` authoritatively,
  // exactly like moveProject. Create/rename reject so the dialog can show
  // the backend's message inline.
  const createSidebarGroup = async (name: string, projectPath: string | null): Promise<void> => {
    await backend.createSidebarGroup(name, projectPath);
  };
  const renameSidebarGroup = async (groupId: string, name: string): Promise<void> => {
    await backend.renameSidebarGroup(groupId, name);
  };
  const removeSidebarGroup = async (groupId: string): Promise<void> => {
    try {
      await backend.removeSidebarGroup(groupId);
    } catch (err) {
      get().reportError(err);
    }
  };
  const moveSidebarGroup = async (groupId: string, beforeGroupId: string | null): Promise<void> => {
    try {
      await backend.moveSidebarGroup(groupId, beforeGroupId);
    } catch (err) {
      get().reportError(err);
    }
  };
  const setSidebarGroupCollapsed = async (groupId: string, collapsed: boolean): Promise<void> => {
    try {
      await backend.setSidebarGroupCollapsed(groupId, collapsed);
    } catch (err) {
      get().reportError(err);
    }
  };
  const setProjectSidebarGroup = async (projectPath: string, groupId: string | null): Promise<void> => {
    try {
      await backend.setProjectSidebarGroup(projectPath, groupId);
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

  // No optimistic update: the `stateChanged` broadcast replaces `state`
  // authoritatively, exactly like moveProject. A rejected remote call is
  // reported and resolved — the local registry is never touched as a fallback.
  const toggleFavorite = async (
    key: string,
    instanceId: string | null = null,
  ): Promise<void> => {
    try {
      await backendFor(instanceId).toggleFavorite(key);
    } catch (err) {
      get().reportError(err);
    }
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
    let landed = false;
    const landTab = ({ tabId }: { tabId: string }) => {
      if (landed) return;
      landed = true;
      set((s) => ({
        tabs: [...s.tabs, { tabId, mode, projectCwd, hidden: false, instanceId }],
        ...focusOn(s, tabId, projectKey(instanceId, projectCwd)),
        exited: dropExited(s.exited, tabId),
      }));
      // A fresh session is the moment the user checks what the remote has
      // (issue #708): fire the upstream read the chip's badge needs, without
      // awaiting it — a slow fetch must never delay the tab landing.
      void get().refreshBranches(projectCwd, { fetchUpstream: true }, instanceId);
    };
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
    const pending = backendFor(instanceId).spawnSession(request);
    // Late landing: after the timeout notice below has fired, a spawn that
    // eventually completes still mounts its tab — exactly once, through the
    // shared `landed` flag; a late rejection is swallowed because the
    // timeout notice already reported the stall.
    pending.then(landTab, () => {});
    try {
      await Promise.race([
        pending.then(landTab),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () => reject(new Error(t("session.error.spawnTimedOut"))),
            SPAWN_SETTLE_MS,
          ),
        ),
      ]);
    } catch (err) {
      if (!landed) get().reportError(err);
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
    if (confirmation.kind === "rewind") {
      // Stale target rule (issue #680): the entry id is durable — entries are
      // never deleted — so only the tab's liveness needs re-checking. A tab
      // whose process died meanwhile dismisses harmlessly; resume first.
      const rec = findRecord(get().state, confirmation.tabId);
      if (!rec || rec.live !== "live" || rec.mode !== "rpc-ui") return;
      await get().performRewind(
        confirmation.tabId,
        confirmation.entryId,
        confirmation.editResend,
      );
      return;
    }
    if (confirmation.kind === "fork") {
      // Same durable-entry rule as rewind (issue #680): entries are never
      // deleted, so only liveness is re-checked (issue #717).
      const rec = findRecord(get().state, confirmation.tabId);
      if (!rec || rec.live !== "live" || rec.mode !== "rpc-ui") return;
      await get().performFork(confirmation.tabId, confirmation.entryId);
      return;
    }
    if (confirmation.kind === "navigate") {
      const rec = findRecord(get().state, confirmation.tabId);
      if (!rec || rec.live !== "live" || rec.mode !== "rpc-ui") return;
      await get().performNavigate(
        confirmation.tabId,
        confirmation.entryId,
        confirmation.summarize,
      );
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
      // Items survive teardown (teardownProcess settles and keeps them):
      // the digest rides the resume so a never-persisted transcript still
      // seeds the successor (#824).
      const digest =
        rec.mode === "rpc-ui" ? composeCarryoverContext(m.effectiveItems(tabId)) : null;
      if (rec.mode === "rpc-ui") prepareRpcRelaunch(tabId);
      await backend.spawnSession({
        origin: "resume",
        resumeTabId: tabId,
        cols: 80,
        rows: 24,
        ...(digest === null ? {} : { carryoverContext: digest }),
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

  /**
   * The issue #774 recovery resume: relaunch a dead rpc tab forcing a fresh
   * model, so a session whose saved model vanished can boot again. Same
   * effect as resumeDead plus the per-spawn `model` override main hands to
   * omp as `--model`.
   */
  const resumeWithModel = async (tabId: string, model: string): Promise<void> => {
    const owner = findOwner(get().state, tabId);
    if (!owner) return;
    const { instanceId, record: rec } = owner;
    try {
      // Inert in main — a #774 recovery resume always has a transcript file
      // to --resume — but the request shape stays uniform with resumeDead
      // (#824).
      const digest =
        rec.mode === "rpc-ui" ? composeCarryoverContext(m.effectiveItems(tabId)) : null;
      if (rec.mode === "rpc-ui") prepareRpcRelaunch(tabId);
      await backend.spawnSession({
        origin: "resume",
        resumeTabId: tabId,
        cols: 80,
        rows: 24,
        model,
        ...(digest === null ? {} : { carryoverContext: digest }),
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
    const confirmation: DeleteConfirmation = {
      tabId,
      title: rec.title,
      running: rec.live === "live",
      hasFiles: rec.live !== "missing",
      worktreeBranch: rec.worktree?.branch ?? null,
      worktreeBase: rec.worktree?.base ?? null,
      worktreePath: rec.worktree?.path ?? null,
      cascade: preview.descendants,
    };
    if (
      get().state?.skipDeleteConfirmation === true &&
      skipConfirmationCovers(confirmation)
    ) {
      await eraseSession(tabId, confirmation.cascade.map((d) => d.tabId));
      return;
    }
    set({ deleteConfirmation: confirmation });
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
    stageLifecycleConfirmation,
    prepareRpcRelaunch,
    resolveSpawnParams,
    teardownProcess,
    dropTab,
    eraseSession,
    spawnFreshImplementation,
    spawnGitResolution,
    resolveWorktreeMerge,
    restartSession,
    addProject,
    removeProject,
    confirmRemoveRemoteInstance,
    moveProject,
    createSidebarGroup,
    renameSidebarGroup,
    removeSidebarGroup,
    moveSidebarGroup,
    setSidebarGroupCollapsed,
    setProjectSidebarGroup,
    moveSession,
    setProjectDefaultModel,
    setProjectDefaultAdvisorModel,
    setProjectBrowserClock,
    setProjectKnowledgeHome,
    vaultNames,
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
    resumeWithModel,
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
