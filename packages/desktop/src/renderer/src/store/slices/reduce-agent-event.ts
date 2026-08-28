import { modelStreamCheckpointLabel } from "@omp-ui/core/stream-activity";
import { formatDuration } from "../../lib/duration";
import { boolField, field, numField, strField } from "../../lib/fields";
import { noticeItem, type NoticeItem } from "../../lib/transcript";
import type { LastTurnMeta, RpcTabState } from "../types";
import type { TabRuntime } from "./shared";

/** Minimum gap between mid-run usage snapshots. */
export const USAGE_REFRESH_MS = 500;

/** pi-ai's StreamTimeoutError classifier bit (Flag.Timeout, pi-ai error/flags.ts). */
const OMP_ERROR_FLAG_TIMEOUT = 0x0004_0000;
/** Every built-in provider's stall/first-event watchdog message (pi-ai providers/*). */
const STALL_MESSAGE_RE =
  /stream (stalled|timed out) while waiting for the (next|first) event/i;

export interface AgentEventPatch {
  rpc?: Partial<RpcTabState>;
  runtime: Partial<TabRuntime>;
}

export interface AgentEventTranscript {
  frame: object;
  stall: NoticeItem | null;
}

type BeforeTranscriptEffect =
  | { phase: "before-transcript"; type: "ensure-stream-stall-timer" };

type BeforeCommitEffect =
  | {
      phase: "before-commit";
      type: "refresh-compaction-usage";
      tokensBefore?: number;
    }
  | { phase: "before-commit"; type: "feed-concern-watcher" }
  | { phase: "before-commit"; type: "feed-advisor-reply-watcher" };

type AfterCommitEffect =
  | {
      phase: "after-commit";
      type: "set-session-model";
      model: string;
      thinkingLevel: string;
    }
  | { phase: "after-commit"; type: "restart-stream-stall-timer" }
  | { phase: "after-commit"; type: "clear-queue-settle-timer" }
  | {
      phase: "after-commit";
      type: "settle-slash-command-items";
      itemIds: ReadonlySet<string>;
    }
  | { phase: "after-commit"; type: "refresh-usage"; settleQueue: boolean }
  | { phase: "after-commit"; type: "rename-session" }
  | {
      phase: "after-commit";
      type: "append-transcript-item";
      item: NoticeItem;
    }
  | { phase: "after-commit"; type: "trigger-stall-continue" };

/**
 * Effects are ordered within each phase. The explicit pre-commit phase keeps
 * the advisor cursor's agent_end ordering visible rather than hiding it in the
 * slice: transcript reduction and watcher feeds must observe the old status.
 */
export type AgentEventEffect =
  | BeforeTranscriptEffect
  | BeforeCommitEffect
  | AfterCommitEffect;

export interface AgentEventReduction {
  patch: AgentEventPatch;
  transcript: AgentEventTranscript;
  effects: AgentEventEffect[];
}

export type ObservedTabRuntime = TabRuntime & { lastFrameAt: number };

/** The per-stall diagnostic notice, or null when this retry is not a stream stall. */
function stallNotice(
  tab: RpcTabState,
  frame: object,
  now: number,
): { notice: NoticeItem; count: number } | null {
  const errorMessage = strField(frame, "errorMessage") ?? "";
  const errorId = numField(frame, "errorId") ?? 0;
  const watchdogMatch = STALL_MESSAGE_RE.exec(errorMessage);
  if ((errorId & OMP_ERROR_FLAG_TIMEOUT) === 0 && watchdogMatch === null)
    return null;
  const count = (tab.stallCount ?? 0) + 1;
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
    detail = `${stage} watchdog fired after ${formatDuration(now - checkpoint.at)} since ${checkpoint.label}. Review Settings → omp → Providers.`;
  }
  return {
    notice: noticeItem(
      `provider stream stall #${count} — ${detail}${upstream}`,
      "warn",
    ),
    count,
  };
}

/** A turn's terminal message ended in a stream stall/timeout. */
function isStreamStallEnd(lastTurn: LastTurnMeta): boolean {
  if (lastTurn.stopReason !== "error") return false;
  return (
    ((lastTurn.errorId ?? 0) & OMP_ERROR_FLAG_TIMEOUT) !== 0 ||
    STALL_MESSAGE_RE.test(lastTurn.errorMessage ?? "")
  );
}

/**
 * Purely reduces an observed agent event to state, transcript, and ordered
 * effect intents. Payload internals remain unknown and are read only through
 * the renderer's field parsers.
 */
export function reduceAgentEvent(
  tab: RpcTabState,
  runtime: ObservedTabRuntime,
  frame: object,
): AgentEventReduction {
  const type = strField(frame, "type");
  const now = runtime.lastFrameAt;
  const rpc: Partial<RpcTabState> = {};
  const runtimePatch: Partial<TabRuntime> = { lastFrameAt: now };
  let hasRpcPatch = false;
  const effects: AgentEventEffect[] = [];
  const checkpointLabel = modelStreamCheckpointLabel(frame);

  if (checkpointLabel !== null) {
    rpc.streamCheckpoint = { at: now, label: checkpointLabel };
    hasRpcPatch = true;
  }

  if (tab.status === "running")
    effects.push({
      phase: "before-transcript",
      type: "ensure-stream-stall-timer",
    });

  const retryStall =
    type === "auto_retry_start" ? stallNotice(tab, frame, now) : null;
  if (retryStall !== null) {
    rpc.stallCount = retryStall.count;
    hasRpcPatch = true;
  }

  if (type === "auto_compaction_start")
    runtimePatch.compactionUsageGeneration = undefined;

  if (type === "auto_compaction_end") {
    const tokensBefore = numField(field(frame, "result"), "tokensBefore");
    const validTokens =
      boolField(frame, "aborted") !== true &&
      tokensBefore !== undefined &&
      Number.isFinite(tokensBefore) &&
      tokensBefore > 0
        ? tokensBefore
        : undefined;
    effects.push({
      phase: "before-commit",
      type: "refresh-compaction-usage",
      ...(validTokens !== undefined ? { tokensBefore: validTokens } : {}),
    });
  }

  effects.push(
    { phase: "before-commit", type: "feed-concern-watcher" },
    { phase: "before-commit", type: "feed-advisor-reply-watcher" },
  );

  if (type === "thinking_level_changed") {
    const thinkingLevel = strField(frame, "thinkingLevel");
    if (thinkingLevel !== undefined && thinkingLevel !== "") {
      rpc.session = { ...tab.session, thinkingLevel };
      hasRpcPatch = true;
      if (tab.model !== null)
        effects.push({
          phase: "after-commit",
          type: "set-session-model",
          model: `${tab.model.provider}/${tab.model.id}`,
          thinkingLevel,
        });
    }
  }

  if (type === "agent_start") {
    rpc.status = "running";
    rpc.lastTurn = undefined;
    hasRpcPatch = true;
    effects.push(
      { phase: "after-commit", type: "restart-stream-stall-timer" },
      { phase: "after-commit", type: "clear-queue-settle-timer" },
    );
    if (runtime.slashCommandItems.size > 0) {
      const itemIds = new Set(runtime.slashCommandItems.values());
      runtimePatch.slashCommandItems = new Map<string, string>();
      effects.push({
        phase: "after-commit",
        type: "settle-slash-command-items",
        itemIds,
      });
    }
  }

  if (type === "message_end") {
    const message = field(frame, "message");
    if (strField(message, "role") === "assistant") {
      rpc.lastTurn = {
        stopReason: strField(message, "stopReason"),
        errorMessage: strField(message, "errorMessage"),
        errorId: numField(message, "errorId"),
      };
      hasRpcPatch = true;
    }
    if (
      tab.status === "running" &&
      now - (runtime.lastUsageRefresh ?? -Infinity) >= USAGE_REFRESH_MS
    ) {
      runtimePatch.lastUsageRefresh = now;
      effects.push({
        phase: "after-commit",
        type: "refresh-usage",
        settleQueue: false,
      });
    }
  }

  if (type === "agent_end") {
    if (tab.status === "running") {
      rpc.status = "ready";
      rpc.streamStallMs = undefined;
      hasRpcPatch = true;
    }
    if (tab.initialPrompt && !tab.hasRenamed)
      effects.push({ phase: "after-commit", type: "rename-session" });
    effects.push({
      phase: "after-commit",
      type: "refresh-usage",
      settleQueue: true,
    });

    const providerStall =
      tab.lastTurn !== undefined && isStreamStallEnd(tab.lastTurn);
    if (providerStall) {
      const stall = stallNotice(
        tab,
        {
          errorMessage: tab.lastTurn?.errorMessage,
          errorId: tab.lastTurn?.errorId,
        },
        now,
      );
      if (stall !== null) {
        rpc.stallCount = stall.count;
        hasRpcPatch = true;
        effects.push({
          phase: "after-commit",
          type: "append-transcript-item",
          item: stall.notice,
        });
      }
    }

    const watchdogAbort = tab.stallAbortPending === true;
    if (watchdogAbort) {
      rpc.stallAbortPending = false;
      hasRpcPatch = true;
    }
    if (providerStall || watchdogAbort)
      effects.push({
        phase: "after-commit",
        type: "trigger-stall-continue",
      });
  }

  return {
    patch: {
      ...(hasRpcPatch ? { rpc } : {}),
      runtime: runtimePatch,
    },
    transcript: { frame, stall: retryStall?.notice ?? null },
    effects,
  };
}
