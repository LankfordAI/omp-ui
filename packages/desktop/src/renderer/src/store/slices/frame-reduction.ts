// Frame reduction domain (decomposed for #295): the handleRpcFrame dispatch,
// its stall diagnostics, the throttled usage/roster refreshes, and the
// queue-settle re-fetch.
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
import { modelStreamCheckpointLabel } from "@omp-ui/core/stream-activity";
import { backend } from "../../backend";
import { formatDuration } from "../../lib/duration";
import {
  extensionCancelResponse,
  routeExtensionRequest,
} from "../../lib/extension-router";
import { arrField, boolField, field, numField, strField } from "../../lib/fields";
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
  type NoticeItem,
  type RenderItem,
} from "../../lib/transcript";
import {
  bumpCompactionUsageGeneration,
  compactionUsageGenerations,
  respData,
  retireTimedOutCommand,
  retireTimedOutEarlierThan,
  type GetState,
  type StoreMachinery,
  type Watchers,
} from "./shared";
import { upsertPlan } from "./plan-execution";
import { findRecord } from "./view";
import type { LastTurnMeta, RpcTabState, UiStore } from "../types";

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

/** pi-ai's StreamTimeoutError classifier bit (Flag.Timeout, pi-ai error/flags.ts). */
const OMP_ERROR_FLAG_TIMEOUT = 0x0004_0000;
/** Every built-in provider's stall/first-event watchdog message (pi-ai providers/*). */
const STALL_MESSAGE_RE =
  /stream (stalled|timed out) while waiting for the (next|first) event/i;

/**
 * The per-stall diagnostic notice (issue #100), or null when this retry is
 * not a stream stall. Detection prefers omp's Timeout errorId bit, falling
 * back to the stable watchdog message text; either alone suffices.
 */
function stallNotice(tab: RpcTabState, frame: object): NoticeItem | null {
  const errorMessage = strField(frame, "errorMessage") ?? "";
  const errorId = numField(frame, "errorId") ?? 0;
  const watchdogMatch = STALL_MESSAGE_RE.exec(errorMessage);
  if ((errorId & OMP_ERROR_FLAG_TIMEOUT) === 0 && watchdogMatch === null)
    return null;

  tab.stallCount = (tab.stallCount ?? 0) + 1;
  const checkpoint = tab.streamCheckpoint;
  const stage =
    watchdogMatch?.[2]?.toLowerCase() === "first"
      ? "first-event"
      : watchdogMatch
        ? "idle"
        : null;
  const upstream = errorMessage ? ` Upstream error: ${errorMessage}` : "";
  let detail: string;
  if (stage === null) {
    detail =
      "OMP classified the retry as a stream timeout but supplied no watchdog stage. Review Settings → omp → Providers.";
  } else if (checkpoint === undefined) {
    detail = `the ${stage} watchdog fired, but no model-stream checkpoint was observed in this tab before it fired. Review Settings → omp → Providers.`;
  } else {
    detail = `${stage} watchdog fired after ${formatDuration(Date.now() - checkpoint.at)} since ${checkpoint.label}. Review Settings → omp → Providers.`;
  }
  return noticeItem(
    `provider stream stall #${tab.stallCount} — ${detail}${upstream}`,
    "warn",
  );
}

/** A turn's terminal message ended in a stream stall/timeout, not a user interrupt or other error. */
function isStreamStallEnd(lt: LastTurnMeta): boolean {
  if (lt.stopReason !== "error") return false;
  return (
    ((lt.errorId ?? 0) & OMP_ERROR_FLAG_TIMEOUT) !== 0 ||
    STALL_MESSAGE_RE.test(lt.errorMessage ?? "")
  );
}

/**
 * Minimum gap between mid-run get_state/get_session_stats refreshes, keyed by
 * tab. Context and spend only grow at turn boundaries, and an agent run fires
 * several per-turn message_ends in quick succession — throttle to one
 * authoritative snapshot per boundary window instead of one rpc call per frame.
 */
export const USAGE_REFRESH_MS = 500;
export const COMPACTION_USAGE_RETRY_MS = 100;
export const COMPACTION_USAGE_MAX_ATTEMPTS = 6;
const lastUsageRefresh = new Map<string, number>();
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
    const generation = bumpCompactionUsageGeneration(tabId);

    const isCurrent = (): boolean =>
      get().rpc[tabId] !== undefined &&
      compactionUsageGenerations.get(tabId) === generation;
    const finish = (): void => {
      if (compactionUsageGenerations.get(tabId) === generation)
        compactionUsageGenerations.delete(tabId);
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

  /**
   * Live usage tick: context meter AND spend. Fired on each per-turn
   * `message_end` while the agent is mid-run, so the HUD tracks the growing
   * context and cost instead of only snapping to the final values at
   * `agent_end`. Same get_state/get_session_stats sources as the closing
   * refresh — just throttled so a burst of turn boundaries costs one snapshot,
   * not one per frame. get_session_stats is a synchronous message fold in omp,
   * so the extra call is as cheap as get_state.
   */
  const refreshLiveUsage = (tabId: string): void => {
    const now = Date.now();
    if (now - (lastUsageRefresh.get(tabId) ?? -Infinity) < USAGE_REFRESH_MS)
      return;
    lastUsageRefresh.set(tabId, now);
    void get()
      .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
      .then((resp) => m.applyRpcState(tabId, resp))
      .catch(() => {});
    void get()
      .rpcCommand(tabId, { type: "get_session_stats" }, { quiet: true })
      .then((resp) =>
        m.patchRpc(tabId, { stats: parseSessionStats(respData(resp)) }),
      )
      .catch(() => {});
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

  const handleRpcFrame = (tabId: string, frame: object): void => {
      if (frame === null || typeof frame !== "object") return;
      const type = "type" in frame ? frame.type : undefined;
      // ready can beat the spawn IPC response that inserts the renderer tab.
      // bootRpcTab creates its own runtime slot, so it bypasses the ordinary
      // unknown-tab guard.
      if (type === "ready") {
        void get().bootRpcTab(tabId);
        return;
      }
      const tab = get().rpc[tabId];
      if (!tab) return;
      switch (type) {
        case "response": {
          const id =
            "id" in frame && typeof frame.id === "string" ? frame.id : null;
          const pending = id ? tab.pendingCommands.get(id) : undefined;
          if (!pending) {
            // The budget expired first: this late response is the completion
            // observation the timeout attribution waits for (issue #302).
            if (id) retireTimedOutCommand(tabId, id);
            return;
          }
          clearTimeout(pending.timer);
          tab.pendingCommands.delete(id!);
          // The chain is FIFO: this completion proves every earlier-started
          // command completed. `bash` bypasses the chain, so it proves nothing (issue #302).
          if (pending.command !== "bash") retireTimedOutEarlierThan(tabId, pending.startedAt);
          if ("success" in frame && frame.success === false) {
            const message =
              "error" in frame && typeof frame.error === "string"
                ? frame.error
                : "command failed";
            pending.reject(new Error(message));
          } else {
            pending.resolve(frame);
          }
          return;
        }
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
          const markers = (tab.subagentMarkers ??= new Map());
          if (markers.get(key) !== label) {
            markers.set(key, label);
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
          // Plan mode rides the extension channel, so it is claimed before the
          // generic routing: the review dialog must reach the plan pane rather
          // than the raw select dialog, and the status frame is state, not text.
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
              const text = failure.kind === "auth"
                ? `MCP server “${failure.serverName}” failed authentication and is absent from this live session. Open the MCP manager, authenticate through omp’s TUI, then restart the session.`
                : `MCP server “${failure.serverName}” failed to connect and is absent from this live session. Open the MCP manager to inspect its configuration, then restart the session.`;
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
            const id = "id" in frame ? frame.id : undefined;
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
          backend.rpcSend(
            tabId,
            extensionCancelResponse("id" in frame ? frame.id : undefined),
          );
          if (!entry) {
            const method = strField(frame, "method") ?? "?";
            m.appendItem(tabId, markerItem(`extension ${method} auto-cancelled`));
          }
          return;
        }
        case "prompt_result": {
          // Settles a slash-command row whose response carried no
          // `agentInvoked` (older runtime): the wire id maps back to the item.
          const id = "id" in frame && typeof frame.id === "string" ? frame.id : null;
          const byRequest = m.slashCommandItems.get(tabId);
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
        case "omp_ui_error": {
          const message = strField(frame, "message") ?? "omp rpc error";
          const liveState = findRecord(get().state, tabId)?.live;
          // The process died mid-tool, so no agent_end will settle running
          // cards. Settle the effective items — frames still pending in the
          // batch are part of the transcript up to the failure (issue #187).
          const settledItems = settleRunningTools(m.effectiveItems(tabId), "aborted");
          m.cancelTranscriptBatch(tabId);
          compactionUsageGenerations.delete(tabId);
          m.patchRpc(tabId, {
            status: "error",
            failure: {
              message,
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
          // Renderer-observed request/model progress for stall diagnosis. Local
          // tool execution and settlement frames deliberately do not reset it.
          const checkpointLabel = modelStreamCheckpointLabel(frame);
          if (checkpointLabel !== null) {
            tab.streamCheckpoint = { at: Date.now(), label: checkpointLabel };
          }
          // Late-joining clients see frames while "running" without an
          // agent_start — arm the stall clock on any such frame (issue #228).
          if (tab.status === "running") m.ensureStreamStallTimer(tabId);
          // The AgentSessionEvent stream — the actual transcript. Reduction is
          // eager (frame-exact for the watchers below) but the render commit is
          // coalesced — one Zustand set per burst instead of per frame, so the
          // renderer keeps servicing input mid-stream (issue #187).
          const stall =
            type === "auto_retry_start" ? stallNotice(tab, frame) : null;
          m.queueTranscriptFrame(tabId, frame, stall);
          if (type === "auto_compaction_start")
            compactionUsageGenerations.delete(tabId);
          if (type === "auto_compaction_end") {
            const result = field(frame, "result");
            const tokensBefore = numField(result, "tokensBefore");
            const aborted = boolField(frame, "aborted") === true;
            if (
              !aborted &&
              tokensBefore !== undefined &&
              Number.isFinite(tokensBefore) &&
              tokensBefore > 0
            )
              refreshCompactionUsage(tabId, tokensBefore);
            else void m.refreshUsage(tabId);
          }
          // A pending plan-concerns wait settles the moment a fresh advisor
          // finding lands after the verdict (or its bounded deadline fires).
          concernWatcher.feed(tabId);
          // A review that lands with the session idle has nothing carrying it
          // back to the main model — answer it (issue #104).
          //
          // This position is load-bearing; do not move it. The agent_start /
          // agent_end status patches below run AFTER this call, so on the
          // agent_end frame the tab still reads "running": canReply refuses,
          // and the cursor simply advances past the `agent finished` marker.
          // The advisory arriving on a later frame is then above that cursor,
          // with the tab finally "ready" — which is exactly the case to answer.
          advisorReplyWatcher.feed(tabId);
          if (type === "thinking_level_changed") {
            const level = strField(frame, "thinkingLevel");
            if (level) {
              m.patchSession(tabId, { thinkingLevel: level });
              const model = get().rpc[tabId]?.model;
              if (model) {
                void backend
                  .setSessionModel(
                    tabId,
                    `${model.provider}/${model.id}`,
                    level,
                  )
                  .catch(() => {});
              }
            }
          }
          if (type === "agent_start") {
            m.patchRpc(tabId, { status: "running", lastTurn: undefined });
            // A stale entry from a prior run (its tick has not fired yet)
            // must not block the fresh arm.
            m.stopStreamStallTimer(tabId);
            m.ensureStreamStallTimer(tabId);
            const pending = queueSettleTimers.get(tabId);
            if (pending !== undefined) {
              window.clearTimeout(pending);
              queueSettleTimers.delete(tabId);
            }
            // A slash command still awaiting its verdict (response carried no
            // `agentInvoked`) is what started this turn — mark it so.
            const byRequest = m.slashCommandItems.get(tabId);
            if (byRequest !== undefined && byRequest.size > 0) {
              const tracked = new Set(byRequest.values());
              byRequest.clear();
              m.patchItems(tabId, (i) =>
                i.kind === "command" && i.status === "running" && tracked.has(i.id)
                  ? { ...i, status: "agent" }
                  : i,
              );
            }
          }
          // Context and spend grow at turn boundaries — tick the HUD meter and
          // cost counter live while the agent is still mid-run, not just once
          // at agent_end.
          if (type === "message_end") {
            const message = field(frame, "message");
            if (
              message !== null &&
              typeof message === "object" &&
              strField(message, "role") === "assistant"
            ) {
              // The turn's terminal message end: drives the agent_end settle
              // target and the stall classification below.
              m.patchRpc(tabId, {
                lastTurn: {
                  stopReason: strField(message, "stopReason"),
                  errorMessage: strField(message, "errorMessage"),
                  errorId: numField(message, "errorId"),
                },
              });
            }
            if (tab.status === "running") refreshLiveUsage(tabId);
          }
          if (type === "agent_end") {
            // The tick self-terminates on the next pass; the explicit clear
            // keeps the field from lingering up to a second after the run.
            if (tab.status === "running")
              m.patchRpc(tabId, { status: "ready", streamStallMs: undefined });

            // Retry net: a rename that failed at prompt time (hasRenamed was
            // released) gets another shot at the next turn boundary.
            if (tab.initialPrompt && !tab.hasRenamed)
              get().renameSession(tabId);

            // Refresh todoPhases/contextUsage/isStreaming after each agent run.
            void get()
              .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
              .then((resp) => {
                m.applyRpcState(tabId, resp);
                scheduleQueueSettleRefresh(tabId);
              })
              // The refresh itself was lost — if the last-known count is
              // nonzero it may be frozen; the settle timer is the one retry.
              .catch(() => scheduleQueueSettleRefresh(tabId));

            // Session cost/token totals live on get_session_stats, which is
            // fetched once at boot — a fresh session reads $0 there. Refresh
            // it per run so the HUD cost counter updates instead of freezing
            // at $0.0000 for the whole session.
            void get().refreshStats(tabId);
            // (C) The provider-stall diagnostic posts at every
            // stall-classified error turn-end (issue #250). A watchdog abort
            // (issue #254) posted its own notice from main already.
            // (B) The continue prompt is gated on the app switch (issue #251).
            const lastTurn = get().rpc[tabId]?.lastTurn;
            const providerStall =
              lastTurn !== undefined && isStreamStallEnd(lastTurn);
            if (providerStall) {
              // The ready patch above replaced the stored tab, and stallNotice
              // bumps its stall counter in place — re-fetch the live object so
              // the increment does not land on a detached one.
              const liveTab = get().rpc[tabId];
              if (liveTab !== undefined) {
                const notice = stallNotice(liveTab, {
                  errorMessage: lastTurn.errorMessage,
                  errorId: lastTurn.errorId,
                });
                if (notice) m.appendItem(tabId, notice);
              }
            }
            const watchdogAbort = get().rpc[tabId]?.stallAbortPending === true;
            if (watchdogAbort) m.patchRpc(tabId, { stallAbortPending: false });
            if (
              (providerStall || watchdogAbort) &&
              get().rpc[tabId] !== undefined &&
              get().state?.stallAutoContinue !== false
            )
              stallContinueWatcher.trigger(tabId);
          }
        }
      }
  };

  const appendNotice = (
    tabId: string,
    text: string,
    level?: "info" | "warn" | "error",
  ): void => {
    m.appendItem(tabId, noticeItem(text, level));
  };

  return { handleRpcFrame, appendNotice };
}
