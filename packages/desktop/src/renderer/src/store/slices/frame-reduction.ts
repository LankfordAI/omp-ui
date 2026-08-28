// Frame reduction domain (decomposed for #295): control/data dispatch,
// agent-event effect execution, throttled roster refreshes, and queue settle.
import {
  parsePlanReviewTitle,
  parsePlanStatus,
  PLAN_STATUS_KEY,
} from "@omp-ui/core/plan";
import { parseAdvisorStats, ADVISOR_STATS_KEY } from "@omp-ui/core/advisor-stats";
import {
  MCP_RUNTIME_STATUS_KEY,
  parseMcpRuntimeStatus,
} from "@omp-ui/core/mcp-status";
import { normalizeControlFrame } from "@omp-ui/core/rpc/control-frames";
import { backend } from "../../backend";
import {
  extensionCancelResponse,
  routeExtensionRequest,
} from "../../lib/extension-router";
import { arrField, boolField, field, strField } from "../../lib/fields";
import {
  parseCommandList,
  parseModelInfo,
  parseSessionRuntime,
  parseSessionStats,
} from "../../lib/rpc-types";
import { reduceSubagentFrame, SUBAGENT_BUFFER_CAP, subagentKey } from "../../lib/subagent-events";
import {
  markerItem,
  noticeItem,
  planProposalItem,
  settleRunningTools,
  type CommandItem,
  type RenderItem,
} from "../../lib/transcript";
import { respData, type GetState, type StoreMachinery, type Watchers } from "./shared";
import {
  reduceAgentEvent,
  type AgentEventEffect,
} from "./reduce-agent-event";
import { disposeTabRuntime, rpcCommandMachinery } from "./rpc-command";
import { upsertPlan } from "./plan-execution";
import { findRecord } from "./view";
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
      case "rename-session":
        get().renameSession(tabId);
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

  const handleRpcFrame = (tabId: string, frame: object): void => {
      if (frame === null || typeof frame !== "object") return;
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
      if (control?.kind === "response") {
        if (typeof control.id === "string") {
          rpcCommandMachinery.settle(
            tabId,
            control.id,
            {
              success: control.success !== false,
              frame: control.frame,
              error: control.error,
            },
            m,
          );
        }
        return;
      }
      if (control?.kind === "omp_ui_error") {
        const liveState = findRecord(get().state, tabId)?.live;
        // The process died mid-tool, so no agent_end will settle running
        // cards. Settle the effective items — frames still pending in the
        // batch are part of the transcript up to the failure (issue #187).
        const settledItems = settleRunningTools(m.effectiveItems(tabId), "aborted");
        disposeTabRuntime(tabId, "the session process stopped", deps, m);
        m.patchRpc(tabId, {
          status: "error",
          failure: {
            message: control.message,
            kind: "process",
            fatal: true,
            sessionStatus: "error",
            ...(liveState !== undefined ? { liveState } : {}),
            recovery:
              "The live session process stopped. Resume the session to continue.",
          },
          items: settledItems,
          // Process death is terminal for this run (issue #228).
          streamStallMs: undefined,
        });
        return;
      }
      switch (type) {
        case "rpc_chunk":
          return; // reassembled in main — never expected here
        case "session_info_update":
          m.patchRpc(tabId, { session: parseSessionRuntime(frame, tab.session) });
          return;
        case "config_update": {
          const model = parseModelInfo(field(frame, "model")) ?? tab.model;
          const session = parseSessionRuntime(frame, tab.session);
          m.patchRpc(tabId, { model, session });
          if (model) {
            void backend
              .setSessionModel(
                tabId,
                `${model.provider}/${model.id}`,
                session.thinkingLevel,
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
          const markers = new Map(tab.subagentMarkers ?? []);
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
          const buffers = tab.subagentItems ?? {};
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
            m.patchRpc(tabId, {
              planReview: { request: review, frame },
              // A fresh proposal is never deferred — it demands its verdict.
              planDeferred: false,
              plans: upsertPlan(tab.plans, review.title, review.planFilePath),
            });
            const planItem = planProposalItem(
              review.title,
              review.planFilePath,
              review.planAbsPath,
            );
            m.appendItem(tabId, planItem);
            void get().loadPlanText(tabId, review.planAbsPath, planItem.id);
            return;
          }
          const entry = extensionStatusEntry(frame);
          if (entry?.key === PLAN_STATUS_KEY) {
            m.patchRpc(tabId, { plan: parsePlanStatus(entry.text) });
            return;
          }
          if (entry?.key === ADVISOR_STATS_KEY) {
            // Included in a catch-up snapshot only when the frame has
            // arrived by settle time; a later frame never re-settles a
            // taken snapshot (issue #273).
            m.patchRpc(tabId, { advisorStats: parseAdvisorStats(entry.text) });
            return;
          }
          if (entry?.key === MCP_RUNTIME_STATUS_KEY) {
            const mcpStatus = parseMcpRuntimeStatus(entry.text);
            if (mcpStatus === null) return;
            const observed = new Set(
              (tab.mcpStatus?.failedServers ?? []).map(
                (failure) => `${failure.kind}\u0000${failure.serverName}`,
              ),
            );
            for (const failure of mcpStatus.failedServers) {
              const key = `${failure.kind}\u0000${failure.serverName}`;
              if (observed.has(key)) continue;
              observed.add(key);
              // The manager's footer offers `/mcp reload`, which rebinds the
              // live session's MCP tools in place (#327) — the restart this
              // copy used to name is no longer the lever.
              const text = failure.kind === "auth"
                ? `MCP server “${failure.serverName}” failed authentication and is absent from this live session. Open the MCP manager, authenticate through omp’s TUI, then reload MCP in this session.`
                : `MCP server “${failure.serverName}” failed to connect and is absent from this live session. Open the MCP manager to inspect its configuration, then reload MCP in this session.`;
              m.appendItem(tabId, noticeItem(text, "warn"));
            }
            m.patchRpc(tabId, { mcpStatus });
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
          const byRequest = m.runtime(tabId).slashCommandItems;
          const itemId = id !== null ? byRequest?.get(id) : undefined;
          if (byRequest !== undefined && id !== null && itemId !== undefined) {
            byRequest.delete(id);
            const invoked =
              boolField(frame, "agentInvoked") ??
              boolField(field(frame, "data"), "agentInvoked");
            m.patchItems(tabId, (i) =>
              i.kind === "command" && i.id === itemId && i.status === "running"
                ? { ...i, status: invoked === true ? "agent" : "done" }
                : i,
            );
          }
          m.patchRpc(tabId, { status: "ready" });
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
          // No host tools are registered — answer with an error, never hang the agent.
          backend.rpcSend(tabId, {
            type: "host_tool_result",
            id: "id" in frame ? frame.id : undefined,
            error: "omp-ui does not register host tools",
          });
          return;
        case "host_uri_request":
          // Same discipline: omp awaits a result for every uri request.
          backend.rpcSend(tabId, {
            type: "host_uri_result",
            id: "id" in frame ? frame.id : undefined,
            error: "omp-ui registers no uri schemes",
          });
          return;
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
