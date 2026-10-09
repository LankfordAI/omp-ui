// Frame reduction domain (decomposed for #295): control/data dispatch,
// agent-event effect execution, throttled roster refreshes, and queue settle.
import {
  parsePlanReviewTitle,
  parsePlanStatus,
  PLAN_STATUS_KEY,
} from "@omp-ui/core/plan";
import { parseAdvisorStats, ADVISOR_STATS_KEY } from "@omp-ui/core/advisor-stats";
import { parseLimits, LIMITS_STATUS_KEY } from "@omp-ui/core/limits";
import {
  MCP_RUNTIME_STATUS_KEY,
  parseMcpRuntimeStatus,
} from "@omp-ui/core/mcp-status";
import { goalStateFromFrame } from "@omp-ui/core/goal";
import { VIBE_STATUS_KEY, parseVibeSnapshot } from "@omp-ui/core/vibe";
import { applyBtwDelta, applyBtwRecord, parseBtwRecord } from "@omp-ui/core/side-questions";
import {
  applyLiveEnd,
  applyLiveLevels,
  applyLivePhase,
  applyLiveTranscript,
  appendLiveRecap,
  LIVE_WORK_PARK_CAP_MS,
  LIVE_WORK_PARK_QUIET_MS,
  LIVE_WORK_PARK_QUIET_RMS,
  emptyLiveSnapshot,
  isLiveSessionActive,
  parseLiveLevelsFrame,
  parseLivePhaseFrame,
  parseLiveTranscriptFrame,
} from "@omp-ui/core/live-voice";
import {
  AUTORESEARCH_STATUS_KEY,
  AUTORESEARCH_WIDGET_KEY,
  parseAutoresearchSnapshot,
  parseExperimentProposalTitle,
} from "@omp-ui/core/autoresearch";
import {
  CAPABILITIES_STATUS_KEY,
  parseCapabilitySnapshot,
} from "@omp-ui/core/capabilities";
import { normalizeControlFrame } from "@omp-ui/core/rpc/control-frames";
import {
  hostToolErrorResult,
  hostUriErrorResult,
  parseHostToolCall,
  parseHostUriRequest,
} from "@omp-ui/core/host-bridge";
import { backend } from "../../backend";
import {
  extensionCancelResponse,
  routeExtensionRequest,
} from "../../lib/extension-router";
import { parseApprovalPrompt } from "@omp-ui/core/approval";
import { arrField, boolField, field, strField } from "../../lib/fields";
import {
  parseCommandList,
  parseModelInfo,
  parseQueuedMessages,
  parseSessionRuntime,
  parseSessionStats,
} from "../../lib/rpc-types";
import { reduceSubagentFrame, SUBAGENT_BUFFER_CAP, subagentKey } from "../../lib/subagent-events";
import {
  markerItem,
  noticeItem,
  planProposalItem,
  settleRunningItems,
  type CommandItem,
  type RenderItem,
} from "../../lib/transcript";
import { peekTabRuntime, respData, type GetState, type StoreMachinery, type Watchers } from "./shared";
import {
  armLiveWorkCapTimer,
  armLiveWorkQuietTimer,
  cancelLiveWorkQuietTimer,
  clearLiveWorkTimers,
  liveVoiceGeneration,
  planReviewGateKey,
} from "./live-work-park";
import {
  reduceAgentEvent,
  type AgentEventEffect,
} from "./reduce-agent-event";
import {
  acceptAutoresearchSnapshot,
  acceptCapabilitySnapshot,
  acceptVibeSnapshot,
  disposeTabRuntime,
  noteCapabilitiesSessionChange,
  rpcCommandMachinery,
} from "./rpc-command";
import { findOwner, findRecord, sessionCwd } from "./view";
import type { UiStore } from "../types";

export type FrameReductionSlice = Pick<
  UiStore,
  "handleRpcFrame" | "appendNotice"
>;

/**
 * Per-item ceiling for accumulated command_output text. Unbounded growth is
 * the exact reason issue #43 deleted the drawer's output pane; a bounded
 * per-item buffer is not that.
 */
const COMMAND_OUTPUT_CAP = 64 * 1024;

export { USAGE_REFRESH_MS } from "./reduce-agent-event";
export const COMPACTION_USAGE_RETRY_MS = 100;
export const COMPACTION_USAGE_MAX_ATTEMPTS = 6;
/**
 * One-shot delayed get_state after a turn ends with a nonzero queue count.
 * omp reclaims parked advice and flushes deferred messages on settle, which
 * can land just after agent_end; and every get_state path swallows failure,
 * so a lost end-of-turn refresh otherwise freezes the last count forever
 * (issue #181). One shot only: a count that survives the re-fetch is genuinely
 * parked, and the composer now says so — polling forever would just churn.
 */
export const QUEUE_SETTLE_REFRESH_MS = 1500;
const queueSettleTimers = new Map<string, number>();

/**
 * Heartbeat-driven roster refresh (issue #62): every subagent_* frame wants a
 * roster read, but heartbeats arrive many times a second. Trailing throttle
 * to one quiet get_subagents round-trip per window, with in-flight
 * coalescing — a frame landing mid-request just schedules the trailing call,
 * so the final roster always lands. The Agents pane's manual refresh button
 * bypasses this entirely (it calls refreshSubagents directly).
 */
const SUBAGENT_REFRESH_MS = 500;
interface SubagentRefresh {
  last: number;
  inFlight: boolean;
  pending: boolean;
  timer: number | undefined;
}
const subagentRefresh = new Map<string, SubagentRefresh>();
/** Shared empty buffer so identity comparison detects "no items yet". */
const EMPTY_BUFFER: RenderItem[] = [];

/** setStatus/setWidget/setTitle carry their text under different keys. */
function extensionStatusEntry(
  frame: object,
): { key: string; text: string | undefined } | null {
  const method = strField(frame, "method");
  const id = strField(frame, "id") ?? "";
  if (method === "setWidget") {
    const lines = arrField(frame, "widgetLines").filter(
      (l): l is string => typeof l === "string",
    );
    return {
      key: strField(frame, "widgetKey") ?? id,
      // `widgetLines: undefined` is the protocol's "clear this widget".
      text:
        field(frame, "widgetLines") === undefined
          ? undefined
          : lines.join("\n"),
    };
  }
  if (method === "setStatus") {
    return {
      key: strField(frame, "statusKey") ?? id,
      text: strField(frame, "statusText"),
    };
  }
  if (method === "setTitle") {
    return {
      key: strField(frame, "widgetKey") ?? id,
      text: strField(frame, "title"),
    };
  }
  return null;
}

export function createFrameReductionSlice(
  get: GetState,
  m: StoreMachinery,
  deps: Watchers,
): FrameReductionSlice {
  // The bodies moved from the root closure keep their original names.
  const {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
  } = deps;
  const statusKeyHandlers: Record<string, (tabId: string, text: string | undefined) => void> = {
    [PLAN_STATUS_KEY]: (tabId, text) => {
      m.patchRpc(tabId, { plan: parsePlanStatus(text) });
    },
    [ADVISOR_STATS_KEY]: (tabId, text) => {
      m.patchRpc(tabId, { advisorStats: parseAdvisorStats(text) });
    },
    [LIMITS_STATUS_KEY]: (tabId, text) => {
      m.patchRpc(tabId, { limits: parseLimits(text) });
    },
    [MCP_RUNTIME_STATUS_KEY]: (tabId, text) => {
      const mcpStatus = parseMcpRuntimeStatus(text);
      const tab = get().rpc[tabId];
      if (mcpStatus === null || tab === undefined) return;
      const observed = new Set(
        (tab.mcpStatus?.failedServers ?? []).map(
          (failure) => `${failure.kind}\u0000${failure.serverName}`,
        ),
      );
      for (const failure of mcpStatus.failedServers) {
        const key = `${failure.kind}\u0000${failure.serverName}`;
        if (observed.has(key)) continue;
        observed.add(key);
        const notice = failure.kind === "auth"
          ? `MCP server “${failure.serverName}” failed authentication and is absent from this live session. Open the MCP manager, authenticate through omp’s TUI, then reload MCP in this session.`
          : `MCP server “${failure.serverName}” failed to connect and is absent from this live session. Open the MCP manager to inspect its configuration, then reload MCP in this session.`;
        m.appendItem(tabId, noticeItem(notice, "warn"));
      }
      m.patchRpc(tabId, { mcpStatus });
    },
    [AUTORESEARCH_STATUS_KEY]: (tabId, text) => {
      const snapshot = parseAutoresearchSnapshot(text);
      if (snapshot !== null) acceptAutoresearchSnapshot(tabId, snapshot, get, m);
    },
    [VIBE_STATUS_KEY]: (tabId, text) => {
      const snapshot = parseVibeSnapshot(text);
      if (snapshot !== null) acceptVibeSnapshot(tabId, snapshot, get, m);
    },
    [CAPABILITIES_STATUS_KEY]: (tabId, text) => {
      const snapshot = parseCapabilitySnapshot(text);
      if (snapshot !== null) acceptCapabilitySnapshot(tabId, snapshot, get, m);
    },
  };


  /** Trailing-throttled roster refresh for the subagent_* heartbeat path. */
  const pulseSubagents = (tabId: string): void => {
    let st = subagentRefresh.get(tabId);
    if (!st) {
      st = { last: 0, inFlight: false, pending: false, timer: undefined };
      subagentRefresh.set(tabId, st);
    }
    const state = st;
    const fire = (): void => {
      state.inFlight = true;
      state.last = Date.now();
      void get()
        .refreshSubagents(tabId)
        .finally(() => {
          state.inFlight = false;
          if (state.pending) {
            state.pending = false;
            pulseSubagents(tabId);
          }
        });
    };
    if (state.inFlight) {
      state.pending = true;
      return;
    }
    const wait = state.last + SUBAGENT_REFRESH_MS - Date.now();
    if (wait <= 0) {
      fire();
      return;
    }
    // A scheduled trailing call already covers this frame.
    state.timer ??= window.setTimeout(() => {
      state.timer = undefined;
      fire();
    }, wait);
  };

  const refreshCompactionUsage = (tabId: string, tokensBefore: number): void => {
    const generation = m.bumpCompactionUsageGeneration(tabId);

    const isCurrent = (): boolean =>
      get().rpc[tabId] !== undefined &&
      m.runtime(tabId).compactionUsageGeneration === generation;
    const finish = (): void => {
      if (m.runtime(tabId).compactionUsageGeneration === generation)
        m.patchRuntime(tabId, { compactionUsageGeneration: undefined });
    };

    void get()
      .rpcCommand(tabId, { type: "get_session_stats" }, { quiet: true })
      .then((resp) => {
        if (isCurrent())
          m.patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
      })
      .catch(() => {});

    const attempt = (attempts: number): void => {
      if (!isCurrent()) return;
      void get()
        .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
        .then((resp) => {
          if (!isCurrent()) return;
          const tab = get().rpc[tabId];
          const payload = respData(resp);
          const session =
            tab && payload !== null && typeof payload === "object"
              ? parseSessionRuntime(payload, tab.session)
              : null;
          const tokens = session?.contextUsage?.tokens;
          if (
            typeof tokens === "number" &&
            Number.isFinite(tokens) &&
            tokens < tokensBefore
          ) {
            if (!isCurrent()) return;
            m.applyRpcState(tabId, resp);
            finish();
            return;
          }
          if (attempts >= COMPACTION_USAGE_MAX_ATTEMPTS) {
            finish();
            return;
          }
          window.setTimeout(
            () => attempt(attempts + 1),
            COMPACTION_USAGE_RETRY_MS,
          );
        })
        .catch(() => {
          if (!isCurrent()) return;
          if (attempts >= COMPACTION_USAGE_MAX_ATTEMPTS) {
            finish();
            return;
          }
          window.setTimeout(
            () => attempt(attempts + 1),
            COMPACTION_USAGE_RETRY_MS,
          );
        });
    };

    attempt(1);
  };


  const scheduleQueueSettleRefresh = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab || tab.status === "running") return;
    if (tab.session.queuedMessageCount <= 0) return;
    const prev = queueSettleTimers.get(tabId);
    if (prev !== undefined) window.clearTimeout(prev);
    queueSettleTimers.set(
      tabId,
      window.setTimeout(() => {
        queueSettleTimers.delete(tabId);
        const current = get().rpc[tabId];
        // A new turn's own agent_end re-arms this; never fire mid-turn.
        if (!current || current.status === "running") return;
        void get()
          .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
          .then((resp) => m.applyRpcState(tabId, resp))
          .catch(() => {});
      }, QUEUE_SETTLE_REFRESH_MS),
    );
  };

  const runAgentEventEffect = (
    tabId: string,
    effect: AgentEventEffect,
  ): void => {
    switch (effect.type) {
      case "ensure-stream-stall-timer":
        m.ensureStreamStallTimer(tabId);
        return;
      case "refresh-compaction-usage":
        if (effect.tokensBefore === undefined) void m.refreshUsage(tabId);
        else refreshCompactionUsage(tabId, effect.tokensBefore);
        return;
      case "feed-concern-watcher":
        concernWatcher.feed(tabId);
        return;
      case "feed-advisor-reply-watcher":
        advisorReplyWatcher.feed(tabId);
        return;
      case "set-session-model":
        void backend
          .setSessionModel(tabId, effect.model, effect.thinkingLevel)
          .catch(() => {});
        return;
      case "restart-stream-stall-timer":
        m.stopStreamStallTimer(tabId);
        m.ensureStreamStallTimer(tabId);
        return;
      case "clear-queue-settle-timer": {
        const pending = queueSettleTimers.get(tabId);
        if (pending !== undefined) {
          window.clearTimeout(pending);
          queueSettleTimers.delete(tabId);
        }
        return;
      }
      case "settle-slash-command-items":
        m.patchItems(tabId, (item) =>
          item.kind === "command" &&
          item.status === "running" &&
          effect.itemIds.has(item.id)
            ? { ...item, status: "agent" }
            : item,
        );
        return;
      case "refresh-usage":
        if (effect.settleQueue)
          void m.refreshUsage(tabId, () => scheduleQueueSettleRefresh(tabId));
        else void m.refreshUsage(tabId);
        return;
      case "refresh-branch-diff": {
        // Same project resolution the DiffsPane uses (issue #711): the
        // session's checkout cwd under its owning instance's key.
        const rec = findRecord(get().state, tabId);
        const cwd = sessionCwd(rec);
        if (cwd !== undefined)
          get().refreshBranchDiff(cwd, findOwner(get().state, tabId)?.instanceId ?? null);
        return;
      }
      case "settle-browser-pane-close": {
        // A deferred #530 symmetric close: the agent detached mid-turn and the
        // turn has now ended; if it never re-attached, release the pane.
        const paneView = get().rpc[tabId]?.browserPane;
        if (
          paneView?.open === true &&
          paneView.agentOpened &&
          (paneView.state?.agent ?? "detached") === "detached"
        )
          get().closeBrowserPane(tabId);
        return;
      }
      case "rename-session":
        get().renameSession(tabId);
        return;
      case "refresh-auto-title":
        get().refreshAutoTitle(tabId);
        return;
      case "dispatch-early-title":
        get().dispatchEarlyTitle(tabId);
        return;
      case "arm-delegated-title":
        get().armDelegatedTitle(tabId, effect.prompt);
        return;
      case "append-transcript-item":
        m.appendItem(tabId, effect.item);
        return;
      case "trigger-stall-continue":
        if (
          get().rpc[tabId] !== undefined &&
          get().state?.stallAutoContinue !== false
        )
          stallContinueWatcher.trigger(tabId);
        return;
      case "store-live-pending-feedback": {
        // #811: the items settled with the commit; the last non-empty
        // assistant row is omp's visible final answer (its
        // extractVisibleAssistantText equivalent). Empty text skips the
        // store entirely.
        const items = m.effectiveItems(tabId);
        let text = "";
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i]!;
          if (item.kind === "assistant" && item.text.trim() !== "") {
            text = item.text;
            break;
          }
        }
        if (text === "") return;
        const rt = m.runtime(tabId);
        m.patchRuntime(tabId, {
          livePendingFeedback: [...rt.livePendingFeedback, text],
          // The orphan: an open call never heard a spoken request for this
          // live-owned turn — refresh-restart at the next `listening`.
          ...(effect.callOpen ? { liveOrphanRestart: true } : {}),
        });
        m.syncLiveVoiceBadge(tabId);
        // The listening frame may already have passed; restart now (the
        // frame hook would never fire for it). Other phases leave
        // liveOrphanRestart for the frame hook; restartLiveCall clears it
        // before dispatch.
        // A still-pending work-park defers the restart to the wake effect.
        if (
          effect.callOpen &&
          m.runtime(tabId).liveWorkPark !== true &&
          get().rpc[tabId]?.live?.phase === "listening"
        )
          restartLiveCall(tabId);
        return;
      }
      case "arm-live-work-park": {
        // #815: the delegation landed on an armed, open call and the
        // setting is on — park for the duration of the backend turn. The
        // cap timer bounds a turn that never goes quiet; the quiet timer
        // arms itself from the first quiet `live_levels` frame after a loud
        // one (levels are edge-triggered, so counting frames would drift).
        if (get().state?.liveWorkParking === false) return;
        // A review gate is already the wake boundary, never a new work park.
        if (get().rpc[tabId]?.planReview !== null) return;
        const armLive = get().rpc[tabId]?.live;
        if (armLive === undefined || armLive === null || !isLiveSessionActive(armLive))
          return;
        clearLiveWorkTimers(tabId);
        m.patchRuntime(tabId, {
          liveWorkPark: true,
          liveOutputLoudAt: undefined,
        });
        {
          const armGen = liveVoiceGeneration(tabId);
          armLiveWorkCapTimer(tabId, LIVE_WORK_PARK_CAP_MS, () => {
            const rt = peekTabRuntime(tabId);
            if (
              rt?.liveWorkPark !== true ||
              rt.liveVoiceOwner !== true ||
              rt.liveArmed !== true ||
              liveVoiceGeneration(tabId) !== armGen
            )
              return;
            void get().switchLiveVoice(tabId, { mode: "park" });
          });
        }
        return;
      }
      case "wake-live-call": {
        // #815: the delegated turn ended; the reducer already cleared the
        // flag and this handler clears the timers, since a wake supersedes
        // them. If the call is still open and unparked, omp answered on it
        // (or the park never landed): nothing to reopen. An open-but-parked
        // snapshot or an ended one gets a switch; unviewed tabs leave the
        // stored answer pending for the enter guard instead.
        clearLiveWorkTimers(tabId);
        const wakeRt = peekTabRuntime(tabId);
        if (
          wakeRt === undefined ||
          wakeRt.liveVoiceOwner !== true ||
          wakeRt.liveArmed !== true ||
          wakeRt.liveWorkPark !== false
        )
          return;
        if (get().rpc[tabId]?.live === undefined) return;
        if (get().rpc[tabId]?.live?.ended === false && wakeRt.liveParked !== true)
          return;
        if (get().activeTabId !== tabId) return;
        void get().switchLiveVoice(tabId, { mode: "wake" });
        return;
      }
      default: {
        const exhaustive: never = effect;
        void exhaustive;
      }
    }
  };

  const runAgentEventEffects = (
    tabId: string,
    effects: AgentEventEffect[],
    phase: AgentEventEffect["phase"],
  ): void => {
    for (const effect of effects)
      if (effect.phase === phase) runAgentEventEffect(tabId, effect);
  };

  /** Orphan answers share the work/visibility/review switch. Clear before
   * scheduling so a failed refresh never loops on listening frames. */
  const restartLiveCall = (tabId: string): void => {
    m.patchRuntime(tabId, { liveOrphanRestart: false });
    void get().switchLiveVoice(tabId, { mode: "wake" });
  };

  const handleRpcFrame = (tabId: string, frame: object): void => {
    
      const type = "type" in frame ? frame.type : undefined;
      // Control frames (the grammar core's normalizeControlFrame owns: the
      // command response, ready, the extension request/response, the rpc
      // error) dispatch exhaustively here; everything below is an
      // agent-event/data frame whose fields stay `unknown` to the per-domain
      // parsers.
      const control = normalizeControlFrame(frame);
      // ready can beat the spawn IPC response that inserts the renderer tab.
      // bootRpcTab creates its own runtime slot, so it bypasses the ordinary
      // unknown-tab guard.
      if (control?.kind === "ready") {
        void get().bootRpcTab(tabId);
        return;
      }
      const tab = get().rpc[tabId];
      if (!tab) return;
      const runtime = m.runtime(tabId);
      // Liveness evidence for the late-ack budget: any frame proves the
      // process is alive, even when the command chain is slow (issue #335).
      const observedAt = Date.now();
      m.patchRuntime(tabId, { lastFrameAt: observedAt });
      // omp's goal truth rides three frames (ADR-0046): goal responses, get_state
      // responses, and goal_updated events. One parser for all of them.
      const goalState = goalStateFromFrame(frame);
      if (
        goalState !== undefined &&
        JSON.stringify(goalState) !== JSON.stringify(get().rpc[tabId]?.goal ?? null)
      ) {
        m.patchRpc(tabId, { goal: goalState });
      }
      if (control?.kind === "response") {
        if (typeof control.id === "string") {
          const late = rpcCommandMachinery.settle(
            tabId,
            control.id,
            {
              success: control.success !== false,
              frame: control.frame,
              error: control.error,
            },
            m,
          );
          // A compaction whose ack beat the response budget still completes,
          // and this frame is the only thing that says so (issue #625). Read
          // the record fresh: `tab` above predates every patch in this frame.
          if (late === "compact" && get().rpc[tabId]?.compacting !== undefined)
            m.finishCompaction(tabId, control.success === false ? "failed" : "acked");
        }
        return;
      }
      if (control?.kind === "omp_ui_error") {
        const liveState = findRecord(get().state, tabId)?.live;
        // The process died mid-tool, so no agent_end will settle running
        // cards. Settle the effective items — frames still pending in the
        // batch are part of the transcript up to the failure (issue #187).
        const settledItems = settleRunningItems(m.effectiveItems(tabId), "aborted");
        disposeTabRuntime(tabId, "the session process stopped", deps, m);
        m.patchRpc(tabId, {
          status: "error",
          failure: {
            message: control.message,
            kind: "process",
            fatal: true,
            sessionStatus: "error",
            ...(liveState !== undefined ? { liveState } : {}),
            ...(control.failedModel !== undefined ? { failedModel: control.failedModel } : {}),
            recovery:
              "The live session process stopped. Resume the session to continue.",
          },
          items: settledItems,
          // Process death is terminal for this run (issue #228).
          streamStallMs: undefined,
          activeTurnKeywords: [],
        });
        return;
      }
      switch (type) {
        case "extension_ui_response":
          return;
        case "rpc_chunk":
          return; // reassembled in main — never expected here
        case "queue_update": {
          // omp's own queue snapshot (issue #714): render the chip list from
          // it, never from local bookkeeping. The count stays get_state's —
          // it also covers advisor cards and deferred items this list omits.
          const queued = parseQueuedMessages(frame);
          if (queued !== null) m.patchSession(tabId, { queuedMessages: queued });
          return;
        }
        case "session_info_update": {
          const session = parseSessionRuntime(frame, tab.session);
          m.patchRpc(tabId, { session });
          if (tab.session.sessionId !== null && tab.session.sessionId !== session.sessionId) {
            m.patchRpc(tabId, { activeTurnKeywords: [] });
            m.patchRuntime(tabId, {
              pendingTurnKeywords: [],
              keywordInputBatchStarted: false,
            });
          }
          // The live session changed identity in place (`/new`, `/switch`,
          // `/branch`): a roster sampled for the predecessor is someone
          // else's inventory now, so drop it and re-read (issue #374).
          noteCapabilitiesSessionChange(tabId, session.sessionId, get, m);
          return;
        }
        case "config_update": {
          const model = parseModelInfo(field(frame, "model")) ?? tab.model;
          const session = parseSessionRuntime(frame, tab.session);
          m.patchRpc(tabId, { model, session });
          if (tab.session.sessionId !== null && tab.session.sessionId !== session.sessionId) {
            m.patchRpc(tabId, { activeTurnKeywords: [] });
            m.patchRuntime(tabId, {
              pendingTurnKeywords: [],
              keywordInputBatchStarted: false,
            });
          }
          noteCapabilitiesSessionChange(tabId, session.sessionId, get, m);
          if (model) {
            // Persist the SELECTOR: under auto the frame's thinkingLevel is a
            // per-turn classification output, and writing it would convert the
            // session from auto to a pinned level.
            void backend
              .setSessionModel(
                tabId,
                `${model.provider}/${model.id}`,
                session.thinkingConfigured === "auto" ? "auto" : session.thinkingLevel,
              )
              .catch(() => {});
          }
          return;
        }
        case "available_commands_update":
          m.patchRpc(tabId, { commands: parseCommandList(frame) });
          return;
        case "subagent_lifecycle":
        case "subagent_progress":
        case "subagent_event": {
          const payload = field(frame, "payload");
          const progress = field(payload, "progress");
          // The agent key is id-first: the display name flips between frame
          // types for one agent, which keyed the old consecutive-only dedupe
          // wrong and flooded the transcript (issue #62).
          const key = subagentKey(frame);
          const name =
            strField(payload, "agent") ??
            strField(progress, "agent") ??
            strField(payload, "id") ??
            "subagent";
          const status =
            strField(payload, "status") ?? strField(progress, "status");
          const label = status
            ? `subagent ${name}: ${status}`
            : `subagent ${name}`;
          // Per-agent marker coalescing: a heartbeat repeats its label
          // forever, so only a genuine transition stamps a marker — no
          // matter how several agents' frames interleave.
          const markers = new Map(tab.subagentMarkers);
          if (markers.get(key) !== label) {
            markers.set(key, label);
            m.patchRpc(tabId, { subagentMarkers: markers });
            m.appendItem(tabId, markerItem(label, "copper"));
          }
          // Per-agent buffer for the subagent view and the Agents pane
          // roster (issue #63). Identity return means the frame added
          // nothing. The viewed agent's buffer renders in the subagent
          // view's full transcript — it must not truncate; the cap bounds
          // retained background buffers.
          const buffers = tab.subagentItems;
          const prev = buffers[key] ?? EMPTY_BUFFER;
          const next = reduceSubagentFrame(
            prev,
            frame,
            tab.selectedSubagent === key ? false : SUBAGENT_BUFFER_CAP,
          );
          if (next !== prev) {
            m.patchRpc(tabId, { subagentItems: { ...buffers, [key]: next } });
          }
          pulseSubagents(tabId);
          return;
        }
        case "extension_error": {
          const text = strField(frame, "error") ?? "extension error";
          m.appendItem(tabId, {
            ...noticeItem(text, "error"),
            source: strField(frame, "extensionPath"),
          });
          return;
        }
        case "command_output": {
          // Attaches to the in-flight slash command's transcript row. omp
          // 17.3.8+ emits this for builtin replies (/computer status,
          // /usage, /context, ...), which is what makes them visible in
          // native sessions; the hard cap means a verbose reply can never
          // regrow the drawer pane issue #43 removed.
          const text = strField(frame, "text") ?? "";
          const running = m.effectiveItems(tabId)
            .filter((i): i is CommandItem => i.kind === "command" && i.status === "running")
            .at(-1);
          if (running === undefined) {
            m.appendItem(tabId, noticeItem(text, "info"));
            return;
          }
          const joined =
            running.output === undefined ? text : `${running.output}\n${text}`;
          const output =
            joined.length <= COMMAND_OUTPUT_CAP
              ? joined
              : `${joined.slice(0, COMMAND_OUTPUT_CAP)}\n… output truncated`;
          m.patchItems(tabId, (i) =>
            i.kind === "command" && i.id === running.id ? { ...i, output } : i,
          );
          return;
        }
        case "extension_ui_request": {
          // The id/method narrowing is normalizeControlFrame's; payload
          // internals (title, statusKey, url) stay unknown into the
          // per-domain parsers below.
          const frameId = control?.kind === "ext_request" ? control.id : undefined;
          const review = parsePlanReviewTitle(strField(frame, "title"));
          if (review) {
            const nextReview = { request: review, frame };
            if (tab.planReview !== null &&
              planReviewGateKey(tab.planReview) === planReviewGateKey(nextReview)) return;
            const planItem = planProposalItem(
              review.title,
              review.planFilePath,
              review.planAbsPath,
            );
            m.appendItem(tabId, planItem);
            get().acceptPlanReview(tabId, nextReview, planItem.id);
            return;
          }
          const proposal = parseExperimentProposalTitle(strField(frame, "title"));
          if (proposal) {
            // The agent is blocked on this select; the New experiment dialog
            // answers it (issue #567). Never the generic queue.
            get().acceptExperimentProposal(tabId, proposal, frame);
            return;
          }
          const approval = parseApprovalPrompt(strField(frame, "title"), field(frame, "options"));
          if (approval) {
            // The tool runner is blocked on this select; the approval card
            // answers it (issue #681). Never the generic queue.
            get().acceptApprovalPrompt(tabId, approval, frame);
            return;
          }
          const entry = extensionStatusEntry(frame);
          if (entry !== null) {
            const handleStatus = statusKeyHandlers[entry.key];
            if (handleStatus !== undefined) {
              handleStatus(tabId, entry.text);
              return;
            }
          }
          if (
            strField(frame, "method") === "setWidget" &&
            strField(frame, "widgetKey") === AUTORESEARCH_WIDGET_KEY
          ) {
            // omp's autoresearch widget is TUI furniture. The snapshot and Lab
            // own its content, but omp still blocks until this reply arrives.
            backend.rpcSend(tabId, extensionCancelResponse(frameId));
            return;
          }
          const action = routeExtensionRequest(frame);
          if (action.action === "dialog") {
            m.patchRpc(tabId, { extensionQueue: [...tab.extensionQueue, frame] });
            return;
          }
          if (action.action === "open-url") {
            const url = strField(frame, "url");
            const id = frameId;
            if (url === undefined || url === "") {
              backend.rpcSend(tabId, extensionCancelResponse(id));
              return;
            }
            // Main's setWindowOpenHandler denies the window and routes through
            // openExternalSafe (https/http/mailto only) — the renderer adds no
            // second policy. Reply immediately: a login flow's callback wait is
            // omp's to time out, never ours to block on the OS browser.
            window.open(url);
            backend.rpcSend(tabId, {
              type: "extension_ui_response",
              id,
              confirmed: true,
            });
            let origin = url;
            try {
              origin = new URL(url).origin;
            } catch {
              // Not parseable as a URL — the marker carries the raw string.
            }
            m.appendItem(tabId, markerItem(`opened browser: ${origin}`));
            return;
          }
          // Every non-dialog method is answered immediately — omp blocks on the
          // reply — but status/widget/title text is recorded first, because it
          // is the extension's actual output, not an interaction to decline.
          if (entry) {
            const extensionStatus = { ...tab.extensionStatus };
            if (entry.text === undefined || entry.text === "")
              delete extensionStatus[entry.key];
            else extensionStatus[entry.key] = entry.text;
            m.patchRpc(tabId, { extensionStatus });
          }
          backend.rpcSend(tabId, extensionCancelResponse(frameId));
          if (!entry) {
            const method =
              control?.kind === "ext_request" && typeof control.method === "string"
                ? control.method
                : "?";
            m.appendItem(tabId, markerItem(`extension ${method} auto-cancelled`));
          }
          return;
        }
        case "prompt_result": {
          // Settles a slash-command row whose response carried no
          // `agentInvoked` (older runtime): the wire id maps back to the item.
          const id = "id" in frame && typeof frame.id === "string" ? frame.id : null;
          const invoked =
            boolField(frame, "agentInvoked") ??
            boolField(field(frame, "data"), "agentInvoked");
          const byRequest = m.runtime(tabId).slashCommandItems;
          const itemId = id !== null ? byRequest?.get(id) : undefined;
          if (byRequest !== undefined && id !== null && itemId !== undefined) {
            byRequest.delete(id);
            m.patchItems(tabId, (i) =>
              i.kind === "command" && i.id === itemId && i.status === "running"
                ? { ...i, status: invoked === true ? "agent" : "done" }
                : i,
            );
          }
          // A prompt that ran no agent (a slash command, the boot's extension
          // arms) says nothing about a turn already in flight: stamping
          // "ready" here erased the running status of a tab that attached
          // mid-turn (#692).
          if (invoked !== false) {
            m.patchRpc(tabId, { status: "ready", activeTurnKeywords: [] });
            m.patchRuntime(tabId, {
              pendingTurnKeywords: [],
              keywordInputBatchStarted: false,
            });
          }
          return;
        }
        case "omp_ui_notice": {
          // Main-process notice frame (issue #248: the stall watchdog's abort
          // report). Appended verbatim, never answered.
          m.appendItem(
            tabId,
            noticeItem(strField(frame, "message") ?? "omp-ui notice", "warn"),
          );
          // A watchdog abort ends the turn with stopReason "aborted", which
          // isStreamStallEnd can never classify — the tagged notice is what
          // feeds auto-continue instead (issue #254).
          if (strField(frame, "reason") === "stall-abort")
            m.patchRpc(tabId, { stallAbortPending: true });
          return;
        }
        case "host_tool_call":
        case "host_uri_request": {
          // Fallback only: the main process owns host traffic on every
          // rpc-ui tab it spawned, and its rpcSend fence consumes this
          // answer when main already did (#688). Reaching the child means
          // nobody answered — so answer an error, never hang the agent.
          const toolCall = parseHostToolCall(frame);
          if (toolCall !== null) {
            backend.rpcSend(
              tabId,
              hostToolErrorResult(toolCall.id, "omp-ui could not answer this host tool call"),
            );
            return;
          }
          const uriRequest = parseHostUriRequest(frame);
          if (uriRequest !== null) {
            backend.rpcSend(
              tabId,
              hostUriErrorResult(uriRequest.id, "omp-ui could not answer this URI request"),
            );
          }
          return;
        }
        case "host_tool_cancel":
        case "host_uri_cancel":
          // omp stopped waiting for the request it cancelled; settle silently —
          // this frame type is host traffic, never an agent event.
          return;
        case "goal_updated":
          // State intake ran above; the HUD chip is the surface, not a marker.
          return;
        case "btw_record": {
          // Side-question state intake (issue #775): the full record on each
          // lifecycle change; last-per-id wins, healing any dropped delta.
          // These frames never become transcript rows — return before the
          // agent-event reducer, the goal_updated precedent.
          const record = parseBtwRecord(
            JSON.stringify(field(frame, "record") ?? null),
          );
          if (record !== null)
            m.patchRpc(tabId, { sideQuestions: applyBtwRecord(tab.sideQuestions, record) });
          return;
        }
        case "btw_delta": {
          // Appends to the running topic's latest answer; a delta for an
          // unknown id (pane opened mid-run) drops — the mount refresh heals.
          const recordId = strField(frame, "recordId");
          const delta = strField(frame, "delta");
          if (recordId !== undefined && delta !== undefined)
            m.patchRpc(tabId, { sideQuestions: applyBtwDelta(tab.sideQuestions, recordId, delta) });
          return;
        }
        case "live_phase": {
          // Live voice state intake (issue #778): the same snapshot-slice
          // pattern as the btw frames above — tolerant parse, patchRpc,
          // return before the agent-event reducer so no transcript rows
          // appear. omp owns the phase machine; an unknown phase value keeps
          // the previous one.
          const phase = parseLivePhaseFrame(frame);
          if (phase !== null) {
            const live = phase === "connecting" && runtime.liveStartInFlight !== undefined
              ? emptyLiveSnapshot() : tab.live ?? emptyLiveSnapshot();
            m.patchRpc(tabId, { live: applyLivePhase(live, phase) });
            get().reconcileLivePlanReview(tabId);
            // Orphan refresh-restart (#811): a stored answer the open call
            // could not receive rides the next start's instructions. Only a
            // fresh transition into `listening` restarts — never during
            // speaking/working (AC 5). `restartLiveCall` clears the flag
            // before dispatching, so a failed start cannot loop-restart.
            if (phase === "listening") {
              const liveRt = m.runtime(tabId);
              // A work-park still pending suppresses the orphan restart:
              // the wake at `agent_end` carries the stored answer anyway,
              // and restarting now would fight the scheduled switch (#815).
              if (
                liveRt.liveVoiceOwner === true &&
                liveRt.liveArmed === true &&
                liveRt.liveOrphanRestart === true &&
                liveRt.liveWorkPark !== true
              )
                restartLiveCall(tabId);
            }
          }
          return;
        }
        case "live_levels": {
          // ≤10 Hz; a direct patch is fine — btw deltas patch at a higher rate.
          const levels = parseLiveLevelsFrame(frame);
          if (levels !== null) {
            const live = tab.live ?? emptyLiveSnapshot();
            m.patchRpc(tabId, { live: applyLiveLevels(live, levels.input, levels.output) });
            // The first level report can be a late view's only evidence of an
            // existing call. Publish review ownership without inventing a phase.
            if (tab.live?.phase == null && tab.live?.levels == null && tab.planReview !== null)
              get().reconcileLivePlanReview(tabId);
            // Work-park quiet deadline (#815): levels are edge-triggered,
            // so the park moment is a scheduled check, not a frame count —
            // a loud frame (the model still speaking, e.g. its "working on
            // it" acknowledgment) marks the output loud and cancels a
            // pending quiet timer; the FIRST quiet frame after a loud one
            // owns the deadline, and quiet before any loud frame never
            // arms (the acknowledgment may not have started yet).
            const levelsRt = m.runtime(tabId);
            if (
              levelsRt.liveWorkPark === true &&
              levelsRt.liveVoiceOwner === true &&
              levelsRt.liveArmed === true &&
              get().activeTabId === tabId
            ) {
              if (levels.output >= LIVE_WORK_PARK_QUIET_RMS) {
                cancelLiveWorkQuietTimer(tabId);
                m.patchRuntime(tabId, { liveOutputLoudAt: Date.now() });
              } else if (levelsRt.liveOutputLoudAt !== undefined) {
                const quietGen = liveVoiceGeneration(tabId);
                armLiveWorkQuietTimer(tabId, LIVE_WORK_PARK_QUIET_MS, () => {
                  const rt = peekTabRuntime(tabId);
                  if (
                    rt?.liveWorkPark !== true ||
                    rt.liveVoiceOwner !== true ||
                    rt.liveArmed !== true ||
                    liveVoiceGeneration(tabId) !== quietGen ||
                    get().activeTabId !== tabId
                  )
                    return;
                  void get().switchLiveVoice(tabId, { mode: "park" });
                });
              }
            }
          }
          return;
        }
        case "live_transcript": {
          // Replaces the entry with the same (role, turn); never appended to
          // the transcript, whose unknown-type path would drop the frames.
          const turn = parseLiveTranscriptFrame(frame);
          if (turn !== null) {
            const live = tab.live ?? emptyLiveSnapshot();
            m.patchRpc(tabId, { live: applyLiveTranscript(live, turn) });
            // #817: persist finals as they arrive — the fold-on-park recap
            // is the model's capped context, not the display record; disk
            // is the only copy that survives a park, a restart, or a quit.
            // Fire-and-forget: the snapshot already rendered the text.
            if (turn.final && live.connectionId !== null) {
              void get().appendLiveHistory(tabId, live.connectionId, turn);
            }
            // The resume's instructions carried `livePendingIncluded`
            // pending answers; the call's first final assistant transcript
            // proves the model got its turn — clear exactly that prefix
            // (#811, AC 4: never on tab selection; later arrivals stay
            // pending, which is the orphan pipeline).
            if (turn.role === "assistant" && turn.final) {
              const liveRt = m.runtime(tabId);
              const n = liveRt.livePendingIncluded ?? 0;
              if (n > 0 && liveRt.livePendingFeedback.length > 0) {
                m.patchRuntime(tabId, {
                  livePendingFeedback: liveRt.livePendingFeedback.slice(n),
                  livePendingIncluded: undefined,
                });
                m.syncLiveVoiceBadge(tabId);
              }
            }
          }
          return;
        }
        case "live_end": {
          // Sent exactly once per session; the strip's dismiss and the
          // control's idle state read `ended`.
          const live = tab.live ?? emptyLiveSnapshot();
          m.patchRpc(tabId, {
            live: applyLiveEnd(live, strField(frame, "error") ?? null),
          });
          // #811: a call that ended on its own (omp's idle timeout, a
          // realtime-side error) never ran parkLiveVoice's recap fold —
          // without it, the resume would speak a recap missing the
          // conversation that just happened. An armed session keeps its
          // intent: the turns fold into the recap and liveParked hands the
          // call back to the enter guard. A park marks liveParked before its
          // stop dispatch, so an early live_end cannot fold those turns again.
          const endedRt = m.runtime(tabId);
          if (isLiveSessionActive(live) && endedRt.liveArmed === true &&
            endedRt.liveParked !== true) {
            const foldRt = m.runtime(tabId);
            m.patchRuntime(tabId, {
              liveRecap: appendLiveRecap(foldRt.liveRecap, live.turns),
              liveParked: true,
            });
            m.syncLiveVoiceBadge(tabId);
          }
          get().reconcileLivePlanReview(tabId);
          return;
        }
        default: {
          const reduction = reduceAgentEvent(
            tab,
            { ...runtime, lastFrameAt: observedAt },
            frame,
          );

          runAgentEventEffects(
            tabId,
            reduction.effects,
            "before-transcript",
          );
          // Transcript reduction stays eager for watcher reads, while its
          // render commit remains coalesced by the machinery (issue #187).
          m.queueTranscriptFrame(
            tabId,
            reduction.transcript.frame,
            reduction.transcript.stall,
          );
          // agent_end watcher feeds intentionally observe the pre-status tab;
          // this explicit phase preserves that load-bearing cursor ordering.
          runAgentEventEffects(tabId, reduction.effects, "before-commit");

          m.patchRuntime(tabId, reduction.patch.runtime);
          if (reduction.patch.rpc !== undefined)
            m.patchRpc(tabId, reduction.patch.rpc);

          runAgentEventEffects(tabId, reduction.effects, "after-commit");
          return;
        }
      }
  };

  /**
   * A notice raised while the tab is booting is staged, not appended: the boot
   * resets `items` and replaces them with fetched history, which would drop it
   * (issue #334). `bootRpcTab` drains the queue once that history is in.
   */
  const appendNotice = (
    tabId: string,
    text: string,
    level?: "info" | "warn" | "error",
  ): void => {
    if (get().rpc[tabId]?.status === "starting") {
      const runtime = m.runtime(tabId);
      m.patchRuntime(tabId, {
        pendingNotices: [...runtime.pendingNotices, { text, level }],
      });
      return;
    }
    m.appendItem(tabId, noticeItem(text, level));
  };

  return { handleRpcFrame, appendNotice };
}
