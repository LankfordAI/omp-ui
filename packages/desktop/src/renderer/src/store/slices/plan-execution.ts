// Plan execution domain (decomposed for #295): the plan-review gate, the
// two transcript watchers (concern fold, advisor reply), and the
// execute/refine dispatch paths.
import type {
  BackendState,
  PlanImplementationSource,
} from "@omp-ui/core/types";
import {
  isHtmlPlanPath,
  PLAN_EXECUTE,
  PLAN_REFINE,
} from "@omp-ui/core/plan";
import { backend } from "../../backend";
import { strField } from "../../lib/fields";
import { AdvisorReplyWatcher } from "../../lib/advisor-reply";
import {
  PlanConcernWatcher,
  withConcerns,
  withExecutionDestination,
  withKeywords,
  type PlanExecutionContext,
  type PlanExecutionOptions,
} from "../../lib/plan-concerns";
import { noticeItem } from "../../lib/transcript";
import { findRecord } from "./view";
import { handedOffPlanSources } from "./shared";
import type { GetState, SetState, StoreMachinery, Watchers } from "./shared";
import type { PlanRecord, PlanRevisionNotes, RpcTabState } from "../types";
export interface PlanExecutionSlice {
  executePlan(
    tabId: string,
    context: PlanExecutionContext,
    options?: PlanExecutionOptions,
  ): void;
  refinePlan(tabId: string, notes?: PlanRevisionNotes): void;
  deferPlanReview(tabId: string): void;
  showPlanReview(tabId: string): void;
  loadPlanText(
    tabId: string,
    absPath: string | null,
    itemId?: string,
  ): Promise<void>;
  /** PlanReview publishes its local preparation readiness here (§6 guard). */
  setPlanReadiness(
    tabId: string,
    readiness: { status: "pending" | "ready" | "failed" | "unavailable"; identity?: string } | null,
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
    concerns: string | null,
    options?: PlanExecutionOptions,
  ): Promise<void>;
}

/** The implementation prompt sent to whichever context executes an approved plan. */
const EXECUTION_PROMPT =
  "The plan review is complete — execute the approved plan now. It is set as this " +
  "session's reference.";

/** Compaction did not settle, so the implementation prompt was never sent. */
const COMPACTION_HELD_NOTICE =
  "compaction did not finish — the implementation prompt was held. " +
  "Refresh state, then compact and send it again from this session.";

/**
 * Records a freshly proposed plan in the session's history. Keyed by the plan
 * artifact path: a refined-and-reproposed plan updates its one pending entry
 * instead of stacking lookalike rows.
 */
export function upsertPlan(
  records: PlanRecord[],
  title: string,
  key: string,
): PlanRecord[] {
  const idx = records.findIndex((r) => r.key === key);
  if (idx === -1) return [{ key, title, status: "pending" }, ...records];
  const current = records[idx]!;
  if (current.status === "pending" && current.title === title) return records;
  return [
    ...records.slice(0, idx),
    { ...current, title, status: "pending" },
    ...records.slice(idx + 1),
  ];
}

/** Settles a proposed plan's record (keeps its position in the history). */
function settlePlan(
  records: PlanRecord[],
  key: string,
  status: PlanRecord["status"],
): PlanRecord[] {
  return records.map((r) => (r.key === key ? { ...r, status } : r));
}

export function createPlanExecutionSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
  deps: PlanExecutionDeps,
): PlanExecutionSlice & PlanRuntime {
  /** Settles every renderer-owned representation of a reviewed plan together. */
  const settlePlanReview = (
    tabId: string,
    key: string,
    verdict: Exclude<PlanRecord["status"], "pending">,
  ): void => {
    m.patchRpc(tabId, {
      plans: settlePlan(get().rpc[tabId]?.plans ?? [], key, verdict),
      planReview: null,
      planText: null,
      planHtml: null,
      planDeferred: false,
    });
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
        // Hydrate — or replace a stale local review (the record wins).
        const frameId =
          review !== null && typeof review.frame === "object" && review.frame !== null
            ? strField(review.frame, "id")
            : null;
        if (frameId !== pending.frameId) {
          m.patchRpc(tabId, {
            planReview: {
              request: {
                title: pending.title,
                planFilePath: pending.planFilePath,
                planAbsPath: pending.planAbsPath,
                // The hash survives late-join hydration (§6): a client that
                // never saw the frame answers with the same identity.
                ...(pending.sourceHash !== undefined ? { sourceHash: pending.sourceHash } : {}),
              },
              // Minimal reconstructed frame: answerPlanSelect reads only `.id`.
              frame: { id: pending.frameId },
            },
            planDeferred: false,
            plans: upsertPlan(tab.plans, pending.title, pending.planFilePath),
          });
          void get().loadPlanText(tabId, pending.planAbsPath);
        }
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
        settlePlanReview(tabId, key, settle.verdict);
      } else {
        // Gate lost without an observed verdict (process died, mode switch):
        // close the pane; the plan row stays a dimmed pending record.
        m.patchRpc(tabId, {
          planReview: null,
          planText: null,
          planHtml: null,
          planDeferred: false,
        });
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
    m.patchRpc(tabId, {
      planReview: null,
      planText: null,
      planHtml: null,
      planDeferred: false,
    });
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
    try {
      const result = await backend.answerPlanReview(
        tabId,
        frameId,
        verdict,
        review.request.sourceHash ?? null,
      );
      return result.status === "accepted";
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
    concerns: string | null,
    options?: PlanExecutionOptions,
  ): void => {
    const message = withKeywords(
      withExecutionDestination(
        withConcerns(EXECUTION_PROMPT, concerns),
        options?.destination,
      ),
      options ?? {},
    );
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
    const tab = get().rpc[tabId];
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
        stagedModel != null &&
        `${stagedModel.provider}/${stagedModel.id}` !==
          (tab?.model ? `${tab.model.provider}/${tab.model.id}` : null)
      ) {
        await get().setModel(tabId, stagedModel);
      }
      if (
        stagedThinkingLevel != null &&
        stagedThinkingLevel !== (tab?.session.thinkingLevel ?? null)
      ) {
        await get().setThinkingLevel(tabId, stagedThinkingLevel);
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
        await m.pollUntil(
          tabId,
          (t) =>
            t?.status === "ready" ||
            t?.status === "error" ||
            get().exited[tabId] !== undefined,
        );
        if (get().rpc[tabId]?.status !== "ready") return;
      }

      if (context === "compacted" && !(await get().compactSession(tabId))) {
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
   * True while the session's own goal bridge owns autonomous work (issue #381):
   * an active or paused goal, a budget-limited goal, or a continuation the child
   * has scheduled or is running. ADR-0019's watchers are bounded auto-prompts; an
   * unbounded goal loop must never be restarted, contradicted, or raced by one,
   * which is exactly what a paused or budget-limited goal forbids.
   */
  const goalOwnsSession = (tabId: string): boolean => {
    const goal = get().rpc[tabId]?.goal ?? null;
    if (goal === null) return false;
    if (goal.continuation !== "idle") return true;
    return goal.goal !== null && goal.goal.status !== "complete";
  };

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

  /**
   * Answers an advisor review that lands after `agent finished`, when nothing in
   * the idle session would carry it back to the main model (issue #104). Same
   * collection core as the plan fold; the watcher owns the batch window, the
   * transcript baseline, and the consecutive-reply guard.
   */
  const advisorReply = new AdvisorReplyWatcher({
    getItems: m.effectiveItems,
    canReply: (tabId) => {
      if (handedOffPlanSources.has(tabId)) return false;
      const tab = get().rpc[tabId];
      if (!tab) return false;
      // #381: an auto-prompt must not bypass an explicit goal pause or budget;
      // goal diagnostics still render — this gates dispatch, not display.
      if (goalOwnsSession(tabId)) return false;
      if (!tab.advisorReply) return false;
      // "ready" only: starting/running/error are all no-prompt states, and a
      // running turn already receives the advisor's notes in its own context.
      if (tab.status !== "ready") return false;
      if (get().exited[tabId] !== undefined) return false;
      // The agent is blocked inside a plan proposal — a follow-up would queue
      // behind a gate that only the user can resolve.
      if (tab.planReview !== null || tab.planDeferred) return false;
      // ADR-0009's fold owns this very review and dispatches it itself.
      if (concern.isActive(tabId)) return false;
      return true;
    },
    onNotice: (tabId, text, level) =>
      m.appendItem(tabId, noticeItem(text, level)),
    onReply: (tabId, message) => {
      void get().sendPrompt(tabId, message, "advisor_reply");
    },
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
    const planImplementationSource = review
      ? Object.freeze({
          sourceTabId: tabId,
          planTitle: review.title,
          planFilePath: review.planFilePath,
        })
      : null;
    if (!planImplementationSource || review === undefined) return;
    const html = isHtmlPlanPath(review.planFilePath);
    if (
      html &&
      !(
        tab?.planReadiness != null &&
        tab.planReadiness.status === "ready" &&
        tab.planReadiness.identity === review.sourceHash
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
      if (planKey) settlePlanReview(tabId, planKey, "executed");
      // The drafting turn's review lands after the verdict, so hold dispatch
      // for it when the user wants the advisor's concerns actioned. Execute
      // only: the execute ToolResult tells the agent to stop and wait, so this
      // turn ends and its review genuinely follows — refine keeps the planner
      // in the same turn and is left immediate. The watcher owns the gate; the
      // store just checks its own advisor config for whether a review is coming.
      const configured = get().rpc[tabId]?.advisorStats?.configured === true;
      if ((options?.addressAdvisor ?? true) && configured) {
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
        null,
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
    const review = get().rpc[tabId]?.planReview?.request;
    const planKey = review?.planFilePath;
    const sendNotes = (): void => {
      if (planKey) settlePlanReview(tabId, planKey, "refined");
      const text = notes?.text?.trim() ?? "";
      const images = notes?.images;
      if (text === "" && !images?.length) return;
      // The planner's current turn continues after the refine verdict; the
      // notes steer it live, and omp appends images after the text block.
      const message = text
        ? `Revise the plan to incorporate these requested changes:\n\n${text}`
        : "Revise the plan per the attached change notes.";
      void get().sendPrompt(tabId, message, "steer", images);
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

  const deferPlanReview = (tabId: string): void => {
    m.patchRpc(tabId, { planDeferred: true });
  };

  const showPlanReview = (tabId: string): void => {
    m.patchRpc(tabId, { planDeferred: false });
  };

  const loadPlanText = async (
    tabId: string,
    absPath: string | null,
    itemId?: string,
  ): Promise<void> => {
    if (!absPath) {
      m.patchRpc(tabId, { planText: null, planHtml: null });
      return;
    }
    // §6: a slow read of the PREVIOUS proposal must not overwrite a newer
    // one. Capture the reviewing frame identity; patch the pane only while
    // it still stands.
    const wanted = get().rpc[tabId]?.planReview ?? null;
    try {
      const text = await backend.readPlanFile(tabId, absPath);
      const now = get().rpc[tabId]?.planReview ?? null;
      const stillCurrent =
        wanted === null ||
        strField(now?.frame ?? null, "id") === strField(wanted.frame, "id");
      if (stillCurrent) {
        // One file, one read: the html plan IS the plan, so `planHtml` is the
        // render-mode flag rather than a second document (ADR-0014).
        m.patchRpc(tabId, {
          planText: text,
          planHtml: isHtmlPlanPath(absPath) ? text : null,
        });
      }
      if (itemId !== undefined) {
        m.patchItems(tabId, (i) =>
          i.kind === "plan" && i.id === itemId ? { ...i, text } : i,
        );
      }
    } catch {
      // The pane falls back to the plan's path — a failed read must never
      // strand the review, because the agent is waiting on the verdict.
      const now = get().rpc[tabId]?.planReview ?? null;
      const stillCurrent =
        wanted === null ||
        strField(now?.frame ?? null, "id") === strField(wanted.frame, "id");
      if (stillCurrent) m.patchRpc(tabId, { planText: null, planHtml: null });
    }
  };

  return {
    reconcilePlanGates,
    concern,
    advisorReply,
    executePlan,
    refinePlan,
    deferPlanReview,
    showPlanReview,
    loadPlanText,
    setPlanReadiness: (tabId, readiness) => m.patchRpc(tabId, { planReadiness: readiness }),
  };
}
