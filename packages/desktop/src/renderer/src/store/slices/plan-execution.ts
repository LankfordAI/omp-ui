// Plan execution domain (decomposed for #295): the plan-review gate, the
// three transcript watchers (concern fold, advisor reply, stall continue),
// and the execute/refine dispatch paths.
import type {
  BackendState,
  PlanImplementationSource,
  PlanSettle,
} from "@omp-ui/core/types";
import {
  isHtmlPlanPath,
  PLAN_EXECUTE,
  PLAN_REFINE,
  planReviewMessage,
} from "@omp-ui/core/plan";
import { goalOwnsSession as coreGoalOwnsSession } from "@omp-ui/core/goal";
import { backend } from "../../backend";
import { strField } from "../../lib/fields";
import { t } from "../../lib/i18n";
import { AdvisorReplyWatcher } from "../../lib/advisor-reply";
import {
  PlanConcernWatcher,
  composeImplementationPrompt,
  type PlanExecutionContext,
  type PlanExecutionOptions,
} from "../../lib/plan-concerns";
import {
  STALL_CONTINUE_LEAD,
  StallContinueWatcher,
} from "../../lib/stall-continue";
import { noticeItem, type AdvisorNote } from "../../lib/transcript";
import { findRecord } from "./view";
import { peekTabRuntime, type GetState, type SetState, type StoreMachinery, type Watchers } from "./shared";
import {
  bumpLiveVoiceGeneration,
  cancelLiveSwitch,
  clearLiveWorkTimers,
  planReviewGateKey,
} from "./live-work-park";
import type { PlanReadiness, PlanRevisionNotes, RpcTabState } from "../types";
export interface PlanExecutionSlice {
  acceptPlanReview(
    tabId: string,
    review: NonNullable<RpcTabState["planReview"]>,
    itemId?: string,
  ): void;
  clearPlanReview(tabId: string, expectedGateKey?: string): void;
  executePlan(
    tabId: string,
    context: PlanExecutionContext,
    options?: PlanExecutionOptions,
  ): void;
  refinePlan(tabId: string, notes?: PlanRevisionNotes): void;
  deferPlanReview(tabId: string): void;
  showPlanReview(tabId: string): void;
  /** Re-raises the review for an interrupted plan (ADR-0033). */
  representPlan(tabId: string, planFilePath: string, title: string): Promise<void>;
  /** Stops tracking an interrupted plan; main refuses a live gate. */
  dismissProposedPlan(tabId: string, planFilePath: string): Promise<void>;
  loadPlanText(
    tabId: string,
    absPath: string | null,
    itemId?: string,
  ): Promise<void>;
  /** PlanReview publishes its local preparation readiness here (§6 guard). */
  setPlanReadiness(
    tabId: string,
    readiness: PlanReadiness | null,
  ): void;
}

export interface PlanRuntime extends Watchers {
  reconcilePlanGates(state: BackendState): void;
}

export interface PlanExecutionDeps {
  spawnFreshImplementation(
    tabId: string,
    planText: string | null,
    planImplementationSource: Readonly<PlanImplementationSource>,
    concerns: readonly AdvisorNote[],
    options?: PlanExecutionOptions,
  ): Promise<void>;
}

/** The implementation prompt sent to whichever context executes an approved plan. */
const EXECUTION_PROMPT =
  "The plan review is complete — execute the approved plan now. It is set as this " +
  "session's reference.";

/** Compaction never settled within the settle deadline, so the prompt was not sent. */
const COMPACTION_HELD_NOTICE =
  "compaction did not finish within 15m — the implementation prompt was held. " +
  "Refresh state, then compact and send it again from this session.";



export function createPlanExecutionSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
  deps: PlanExecutionDeps,
): PlanExecutionSlice & PlanRuntime {
  const cancelReviewSwitch = (tabId: string): void => {
    bumpLiveVoiceGeneration(tabId);
    cancelLiveSwitch(tabId);
    clearLiveWorkTimers(tabId);
  };

  const resetReviewRuntime = (tabId: string): void => {
    const runtime = m.runtime(tabId);
    m.patchRuntime(tabId, {
      planReadSequence: (runtime.planReadSequence ?? 0) + 1,
      liveReviewTextCache: undefined,
      liveReviewAppliedSourceKey: null,
      liveReviewAutoRequestedGateKey: undefined,
      liveReviewExplicitBriefingKey: undefined,
      liveWorkPark: false,
      liveReviewFailedSourceKey: undefined,
      liveOutputLoudAt: undefined,
      liveOrphanRestart: false,
    });
  };

  const clearPlanReview = (tabId: string, expectedGateKey?: string): void => {
    const tab = get().rpc[tabId];
    if (!tab || (expectedGateKey !== undefined &&
      (tab.planReview === null || planReviewGateKey(tab.planReview) !== expectedGateKey))) return;
    cancelReviewSwitch(tabId);
    resetReviewRuntime(tabId);
    m.patchRpc(tabId, {
      planReview: null,
      planText: null,
      planHtml: null,
      planSourceKey: null,
      planReadiness: null,
      planDeferred: false,
      planVoice: { ready: false, busy: false, error: null },
    });
    // Remove review-only instructions through the shared switch queue; the
    // human verdict never waits for a realtime reconnect.
    if (tab.planReview !== null) {
      void get().switchLiveVoice(tabId, { mode: "wake", reviewKey: null });
    }
  };

  const acceptPlanReview = (
    tabId: string,
    review: NonNullable<RpcTabState["planReview"]>,
    itemId?: string,
  ): void => {
    const tab = get().rpc[tabId];
    if (!tab || (tab.planReview !== null &&
      planReviewGateKey(tab.planReview) === planReviewGateKey(review))) return;
    cancelReviewSwitch(tabId);
    resetReviewRuntime(tabId);
    m.patchRpc(tabId, {
      planReview: review,
      planText: null,
      planHtml: null,
      planSourceKey: null,
      planReadiness: null,
      planDeferred: false,
      planVoice: { ready: false, busy: false, error: null },
    });
    void get().loadPlanText(tabId, review.request.planAbsPath, itemId);
    get().reconcileLivePlanReview(tabId);
  };

  /** Settles every renderer-owned representation of a reviewed plan together. */
  const settlePlanReview = (
    tabId: string,
    key: string,
    verdict: PlanSettle["verdict"],
    expectedGateKey: string,
  ): void => {
    clearPlanReview(tabId, expectedGateKey);
    m.patchItems(tabId, (i) =>
      i.kind === "plan" && i.planFilePath === key && i.status === "pending"
        ? { ...i, status: verdict }
        : i,
    );
  };

  /**
   * Reconciles each open rpc tab's plan-review gate against the
   * main-process-owned record on the session summary (issue #215). The
   * record wins: a pending gate hydrates the review pane (a late-joining
   * renderer never saw the proposal frame), and a settled gate closes a
   * verdict another client already made. Idempotent — patches only on
   * disagreement, so it is safe to run on every state broadcast.
   */
  const reconcilePlanGates = (state: BackendState): void => {
    for (const [tabId, tab] of Object.entries(get().rpc)) {
      const rec = findRecord(state, tabId);
      if (rec === undefined) continue;
      const pending = rec.pendingPlan;
      const review = tab.planReview;

      if (pending !== null) {
        get().acceptPlanReview(tabId, {
          request: {
            title: pending.title,
            planFilePath: pending.planFilePath,
            planAbsPath: pending.planAbsPath,
            ...(pending.sourceHash !== undefined ? { sourceHash: pending.sourceHash } : {}),
            ...(pending.represented === true ? { represented: true as const } : {}),
          },
          frame: { id: pending.frameId },
        });
        continue;
      }

      if (review === null) continue; // no local gate, nothing to settle

      // Gate gone. Was this client's review answered somewhere?
      const localId =
        typeof review.frame === "object" && review.frame !== null
          ? strField(review.frame, "id")
          : null;
      const settle = rec.planSettle;
      if (settle !== null && settle.frameId === localId) {
        const key = review.request.planFilePath;
        settlePlanReview(tabId, key, settle.verdict, planReviewGateKey(review));
      } else {
        // Gate lost without an observed verdict (process died, mode switch):
        // close the pane; the plan row stays a dimmed pending record.
        get().clearPlanReview(tabId, planReviewGateKey(review));
      }
    }
  };

  /**
   * Answers the blocked plan-review `select` and clears the pane — the
   * UNACKNOWLEDGED path, kept for markdown gates, whose semantics are
   * unchanged. HTML gates go through `acknowledgePlanReview`: only main's
   * accepted answer may settle one (issue #312 follow-up, §6). Returns false
   * when there is no pending review to answer, so callers skip dispatch.
   */
  const answerPlanSelect = (tabId: string, value: string): boolean => {
    const tab = get().rpc[tabId];
    if (!tab?.planReview) return false;
    const request = tab.planReview.frame;
    const id =
      request !== null && typeof request === "object" && "id" in request
        ? request.id
        : undefined;
    // omp's agent is blocked on this reply — clear the pane only after sending.
    backend.rpcSend(tabId, {
      type: "extension_ui_response",
      id,
      value,
    });
    get().clearPlanReview(tabId, planReviewGateKey(tab.planReview));
    return true;
  };

  /**
   * The acknowledged answer for an HTML gate (§6): main checks the live
   * entry, the gate identity, and — for execute — the validated artifact
   * hash. NOTHING local settles or dispatches before `accepted`; a rejected
   * answer settles through the state reconcile (the record wins), never from
   * this client.
   */
  const acknowledgePlanReview = async (
    tabId: string,
    verdict: "execute" | "refine",
  ): Promise<boolean> => {
    const tab = get().rpc[tabId];
    const review = tab?.planReview;
    if (!review) return false;
    const frameId = strField(review.frame, "id") ?? "";
    const runtime = m.runtime(tabId);
    const gateKey = planReviewGateKey(review);
    try {
      const result = await backend.answerPlanReview(
        tabId,
        frameId,
        verdict,
        review.request.sourceHash ?? null,
      );
      const current = get().rpc[tabId]?.planReview;
      return result.status === "accepted" && peekTabRuntime(tabId) === runtime &&
        get().rpc[tabId] !== undefined &&
        (current === null || (current !== undefined && planReviewGateKey(current) === gateKey));
    } catch {
      return false;
    }
  };

  /**
   * Guarantees the live session is in Build before the implementation prompt
   * runs (issue #165). The execute verdict already exits plan mode in-process
   * inside the extension's proposal handler; this waits for that exit's
   * status frame, and if it never surfaces, drives the mode off directly
   * with the mode command. Bounded: a stuck session must not delay
   * implementation indefinitely. `plan == null` means no extension status was
   * ever published — the session was never armed, so Build holds by
   * construction.
   */
  const ensureBuildMode = async (tabId: string): Promise<void> => {
    const build = (t: RpcTabState | undefined) =>
      t?.plan == null ||
      t?.plan.enabled === false ||
      get().exited[tabId] !== undefined;
    await m.pollUntil(tabId, build);
    if (get().rpc[tabId]?.plan?.enabled !== true) return;
    // The verdict's in-process exit never surfaced — force it. Fire-and-forget:
    // the extension's status frame releases the wait, and a failed command must
    // not delay or abort dispatch (issue #165).
    void get()
      .setPlanMode(tabId, false)
      .catch(() => {});
    await m.pollUntil(tabId, build, 5_000);
  };

  /** Sends the implementation prompt for a settled execute verdict. */
  const dispatchExecutePlan = (
    tabId: string,
    context: PlanExecutionContext,
    planText: string | null,
    planImplementationSource: Readonly<PlanImplementationSource> | undefined,
    concerns: readonly AdvisorNote[],
    options?: PlanExecutionOptions,
  ): void => {
    const message = composeImplementationPrompt({
      lead: EXECUTION_PROMPT,
      plan: null,
      concerns,
      options,
    });
    if (context === "fresh" || context === "worktree") {
      if (!planImplementationSource) return;
      void deps.spawnFreshImplementation(
        tabId,
        planText,
        planImplementationSource,
        concerns,
        options,
      );
      return;
    }
    // What the receiving session runs today — only staged *changes* are applied.
    const rec = findRecord(get().state, tabId);
    const stagedModel = options?.model;
    const stagedThinkingLevel = options?.thinkingLevel;
    const stagedAdvisor = options?.advisor;
    const advisorChanged =
      stagedAdvisor !== undefined &&
      rec !== undefined &&
      (rec.advisor !== stagedAdvisor ||
        (rec.advisorModel ?? null) !== (options?.advisorModel ?? null));

    void (async () => {
      // Only work that cannot run under the drafting turn waits for it:
      // advisor relaunch and between-turn compaction. A plain follow-up must
      // still dispatch synchronously in the verdict frame (issue #165).
      if (advisorChanged || context === "compacted") {
        await m.pollUntil(tabId, (t) => (t?.status ?? "ready") !== "running");
      }
      if (
        (stagedModel != null || stagedThinkingLevel != null) &&
        !(await m.applyStagedParams(tabId, {
          model: stagedModel,
          thinkingLevel: stagedThinkingLevel,
        }))
      ) {
        return;
      }

      let relaunched = false;
      if (advisorChanged && stagedAdvisor !== undefined) {
        // omp binds the advisor at process start, so the change is a relaunch.
        await get().setSessionAdvisor(
          tabId,
          stagedAdvisor,
          options?.advisorModel ?? null,
        );
        relaunched = true;
      }

      // A relaunched process must boot before receiving the implementation;
      // plain follow-ups target the current process and keep the synchronous
      // dispatch path that queues behind the accepted plan turn.
      if (relaunched) {
        await m.pollUntilSettled(tabId);
        if (get().rpc[tabId]?.status !== "ready") return;
      }

      // #336 held the dispatch on any unacknowledged compaction. `pending` is
      // now a distinct state: wait for the boundary, then decide (issue #625).
      if (
        context === "compacted" &&
        (await get().compactSession(tabId, { waitForCompletion: true })) !== "acked"
      ) {
        // Compaction never acknowledged: omp is still busy or wedged, and a
        // prompt sent now queues behind it and fails the same way. Hold the
        // dispatch and say what to do instead of stacking banners (#336).
        m.appendItem(tabId, noticeItem(COMPACTION_HELD_NOTICE, "warn"));
        return;
      }
      if (get().rpc[tabId]?.plan?.enabled === true) {
        await ensureBuildMode(tabId);
      }
      await get().sendPrompt(
        tabId,
        message,
        relaunched ? "prompt" : "follow_up",
      );
    })();
  };

  /**
   * True while omp's goal owns autonomous work (ADR-0046): any goal omp reports
   * that is not complete — active, paused, or budget-limited. ADR-0019's
   * watchers are bounded auto-prompts; omp's unbounded goal loop must never be
   * restarted, contradicted, or raced by one, which is exactly what a paused or
   * budget-limited goal forbids.
   */
  const goalOwnsSession = (tabId: string): boolean =>
    coreGoalOwnsSession(get().rpc[tabId]?.goal ?? null);

  /**
   * Holds an approve verdict's dispatch for the drafting turn's advisor
   * review. This is the store's whole concern-wait surface: the watcher owns
   * the per-tab timers and the single-source settle/fold, and the store just
   * begins, feeds frames, and cancels on teardown. See lib/plan-concerns.ts
   * for the timing and the card/tool-note dedup.
   */
  const concern = new PlanConcernWatcher({
    getItems: m.effectiveItems,
    onNotice: (tabId, text) => m.appendItem(tabId, noticeItem(text, "info")),
    onDispatch: (tabId, intent, concerns) => {
      // The no-double-dispatch guarantee. concernWatcher.feed settles
      // synchronously inside the frame handler, so by the time
      // advisorReplyWatcher.feed runs on that same frame `isActive` already
      // reads false — this reset is what stops the reply watcher from
      // separately answering the very review this dispatch just folded in.
      advisorReply.reset(tabId);
      stall.reset(tabId);
      dispatchExecutePlan(
        tabId,
        intent.context,
        intent.planText,
        intent.planImplementationSource,
        concerns,
        intent.options,
      );
    },
  });

  const autoPromptAllowed = (
    tabId: string,
  ): { ok: true; tab: RpcTabState } | { ok: false; reason: string } => {
    if (get().handedOffFor[tabId] !== undefined) {
      return { ok: false, reason: "plan-handoff" };
    }
    const tab = get().rpc[tabId];
    if (!tab) return { ok: false, reason: "missing-tab" };
    if (goalOwnsSession(tabId)) return { ok: false, reason: "goal-owned" };
    if (tab.status !== "ready") return { ok: false, reason: `status:${tab.status}` };
    if (get().exited[tabId] !== undefined) return { ok: false, reason: "exited" };
    if (tab.planReview !== null || tab.planDeferred) {
      return { ok: false, reason: "plan-gate" };
    }
    return { ok: true, tab };
  };

  const advisorReply = new AdvisorReplyWatcher({
    getItems: m.effectiveItems,
    canReply: (tabId) => {
      const permission = autoPromptAllowed(tabId);
      if (!permission.ok || !permission.tab.advisorReply) return false;
      return !concern.isActive(tabId);
    },
    onNotice: (tabId, text, level) =>
      m.appendItem(tabId, noticeItem(text, level)),
    onReply: (tabId, message) => {
      void get().sendPrompt(tabId, message, "advisor_reply");
    },
  });

  const stall = new StallContinueWatcher({
    canContinue: (tabId) => {
      const permission = autoPromptAllowed(tabId);
      if (!permission.ok) return false;
      if (get().state?.stallAutoContinue === false) return false;
      return permission.tab.extensionQueue.length === 0;
    },
    onDispatch: (tabId) => {
      void get().sendPrompt(tabId, STALL_CONTINUE_LEAD, "stall_continue");
    },
    onNotice: (tabId, text, level) => m.appendItem(tabId, noticeItem(text, level)),
    onCapChange: (tabId, paused) => backend.reportStallCap(tabId, paused),
  });

  const executePlan = (
    tabId: string,
    context: PlanExecutionContext,
    options?: PlanExecutionOptions,
  ): void => {
    // Fresh execution embeds the plan text and persists the proposal source,
    // so capture both before the gate's answer clears the review pane.
    const tab = get().rpc[tabId];
    const planText = tab?.planText ?? null;
    const review = tab?.planReview?.request;
    const planKey = review?.planFilePath;
    const gateKey = tab?.planReview ? planReviewGateKey(tab.planReview) : undefined;
    // A re-presented review (ADR-0033) answers no turn: no drafting turn ends,
    // so no advisor review is coming and nothing may wait for one.
    const represented = review?.represented === true;
    const planImplementationSource = review
      ? Object.freeze({
          sourceTabId: tabId,
          planTitle: review.title,
          planFilePath: review.planFilePath,
        })
      : null;
    if (!planImplementationSource || review === undefined || gateKey === undefined) return;
    const html = isHtmlPlanPath(review.planFilePath);
    if (
      html &&
      !(
        tab?.planSourceKey != null &&
        tab.planHtml !== null &&
        tab.planReadiness != null &&
        tab.planReadiness.sourceKey === tab.planSourceKey &&
        tab.planReadiness.status === "ready" &&
        (review.sourceHash === undefined || tab.planReadiness.identity === review.sourceHash)
      )
    ) {
      // The store-side execution guard (§6): pending/failed/unavailable
      // local preparation, or a different source identity, never executes —
      // not even through a non-button caller.
      return;
    }
    // Everything that follows the verdict: settle the history rows, then
    // hold for the drafting turn's advisor review or dispatch directly.
    const proceed = (): void => {
      if (planKey) settlePlanReview(tabId, planKey, "executed", gateKey);
      // The drafting turn's review lands after the verdict, so hold dispatch
      // for it when the user wants the advisor's concerns actioned. Execute
      // only: the execute ToolResult tells the agent to stop and wait, so this
      // turn ends and its review genuinely follows — refine keeps the planner
      // in the same turn and is left immediate. The watcher owns the gate; the
      // store just checks its own advisor config for whether a review is coming.
      const configured = get().rpc[tabId]?.advisorStats?.configured === true;
      if ((options?.addressAdvisor ?? true) && configured && !represented) {
        concern.begin(tabId, {
          context,
          planText,
          planImplementationSource,
          options,
        });
        return;
      }
      dispatchExecutePlan(
        tabId,
        context,
        planText,
        planImplementationSource,
        [],
        options,
      );
    };
    // Answer the gate first — omp's agent is blocked on the reply, so every
    // exit from the review pane must land its verdict before any dispatch.
    if (html) {
      // HTML: the acknowledged path settles; nothing dispatches unaccepted.
      void (async () => {
        if (await acknowledgePlanReview(tabId, "execute")) proceed();
      })();
      return;
    }
    if (!answerPlanSelect(tabId, PLAN_EXECUTE)) return;
    proceed();
  };

  const refinePlan = (tabId: string, notes?: PlanRevisionNotes): void => {
    const gate = get().rpc[tabId]?.planReview;
    if (!gate) return;
    const gateKey = planReviewGateKey(gate);
    const review = gate.request;
    const planKey = review?.planFilePath;
    const sendNotes = (): void => {
      if (planKey) settlePlanReview(tabId, planKey, "refined", gateKey);
      const text = notes?.text?.trim() ?? "";
      const images = notes?.images;
      const documents = notes?.documents;
      if (text === "" && !images?.length && !documents?.length) return;
      // The planner's current turn continues after the refine verdict; the
      // notes steer it live, and omp appends images after the text block.
      const represented = review?.represented === true;
      // A live gate's ToolResult already named the file for the planner. A
      // re-presented one answered no tool call, so the notes must name it.
      const lead = represented ? `Revise the plan at ${planKey}` : "Revise the plan";
      const body = text
        ? `${lead} to incorporate these requested changes:\n\n${text}`
        : `${lead} per the attached change notes.`;
      const message = represented ? `${body}\n\nThen propose it again.` : body;
      // Refine notes carry resolved scratch paths, never raw bytes (ADR-0044).
      void get().sendPrompt(tabId, message, "steer", images, documents);
    };
    if (review !== undefined && isHtmlPlanPath(review.planFilePath)) {
      // Refine needs the same gate identity but NOT unchanged disk bytes —
      // the planner re-reads the artifact itself (§6).
      void (async () => {
        if (await acknowledgePlanReview(tabId, "refine")) sendNotes();
      })();
      return;
    }
    if (!answerPlanSelect(tabId, PLAN_REFINE)) return;
    sendNotes();
  };

  const representPlan = async (
    tabId: string,
    planFilePath: string,
    title: string,
  ): Promise<void> => {
    const tab = get().rpc[tabId];
    // omp refuses an extension command mid-stream, and one review at a time is
    // the extension's own rule; the pane disables the action in both cases.
    if (!tab || tab.status !== "ready" || tab.planReview !== null || !m.acceptsCommands(tabId)) return;
    if (tab.plan?.enabled !== true) await get().setPlanMode(tabId, true);
    await m.runCommand(tabId, { type: "prompt", message: planReviewMessage(planFilePath, title) });
  };

  const dismissProposedPlan = async (tabId: string, planFilePath: string): Promise<void> => {
    try {
      await backend.dismissProposedPlan(tabId, planFilePath);
    } catch (err) {
      // An older remote host has no plan:dismiss (ADR-0028: skew surfaces per call).
      const reason = err instanceof Error ? err.message : String(err);
      m.appendItem(tabId, noticeItem(`could not dismiss the plan: ${reason}`, "warn"));
    }
  };

  const deferPlanReview = (tabId: string): void => {
    cancelReviewSwitch(tabId);
    m.patchRpc(tabId, { planDeferred: true });
    get().reconcileLivePlanReview(tabId);
  };

  const showPlanReview = (tabId: string): void => {
    m.patchRpc(tabId, { planDeferred: false });
    get().reconcileLivePlanReview(tabId);
  };

  const loadPlanText = async (
    tabId: string,
    absPath: string | null,
    itemId?: string,
  ): Promise<void> => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    const runtime = m.runtime(tabId);
    const wanted = tab.planReview;
    const gateKey = wanted === null ? null : planReviewGateKey(wanted);
    const sequence = (runtime.planReadSequence ?? 0) + 1;
    m.patchRuntime(tabId, { planReadSequence: sequence });
    const current = (): boolean => {
      const review = get().rpc[tabId]?.planReview;
      return peekTabRuntime(tabId) === runtime && runtime.planReadSequence === sequence &&
        gateKey !== null && review != null && review.request.planAbsPath === absPath &&
        planReviewGateKey(review) === gateKey;
    };
    const clearSource = (unavailable = false): void => {
      m.patchRuntime(tabId, { liveReviewTextCache: undefined });
      m.patchRpc(tabId, {
        planText: null,
        planHtml: null,
        planSourceKey: null,
        planReadiness: null,
        planVoice: {
          ready: false,
          busy: false,
          error: unavailable ? t("plan.review.voiceUnavailable") : null,
        },
      });
    };
    if (current()) clearSource();
    if (!absPath) {
      if (current()) {
        clearSource(true);
        get().reconcileLivePlanReview(tabId);
      }
      return;
    }
    try {
      const text = await backend.readPlanFile(tabId, absPath);
      if (current()) {
        // These exact bytes feed both the document and the voice projection.
        m.patchRpc(tabId, {
          planText: text,
          planHtml: isHtmlPlanPath(wanted!.request.planFilePath) ? text : null,
          planSourceKey: text === null ? null : JSON.stringify([gateKey, sequence]),
          planReadiness: null,
          ...(text === null ? { planVoice: {
            ready: false, busy: false, error: t("plan.review.voiceUnavailable"),
          } } : {}),
        });
        get().reconcileLivePlanReview(tabId);
      }
      // An obsolete gate can still enrich its own transcript row, but never
      // the pane or a replacement process's history.
      if (itemId !== undefined && peekTabRuntime(tabId) === runtime) {
        m.patchItems(tabId, (i) =>
          i.kind === "plan" && i.id === itemId ? { ...i, text } : i,
        );
      }
    } catch {
      if (current()) {
        clearSource(true);
        get().reconcileLivePlanReview(tabId);
      }
    }
  };

  const setPlanReadiness = (tabId: string, readiness: PlanReadiness | null): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    if (readiness === null) {
      // A late cleanup from a previous document must not erase a loaded
      // successor's readiness. Installation and retirement clear directly.
      if (tab.planSourceKey !== null) return;
    } else if (tab.planReview === null || tab.planSourceKey === null ||
      readiness.sourceKey !== tab.planSourceKey) {
      return;
    }
    m.patchRpc(tabId, { planReadiness: readiness });
    get().reconcileLivePlanReview(tabId);
  };

  return {
    acceptPlanReview,
    clearPlanReview,
    reconcilePlanGates,
    concern,
    advisorReply,
    stall,
    executePlan,
    refinePlan,
    deferPlanReview,
    showPlanReview,
    loadPlanText,
    representPlan,
    dismissProposedPlan,
    setPlanReadiness,
  };
}
