import { LIVE_DELEGATION_CUSTOM_TYPE } from "@omp-ui/core/live-voice";
import { MAGIC_KEYWORDS } from "@omp-ui/core/magic-keywords";
import { modelStreamCheckpointLabel } from "@omp-ui/core/stream-activity";
import { formatDuration } from "../../lib/duration";
import { arrField, boolField, field, numField, strField } from "../../lib/fields";
import { noticeItem, textFromContent, type NoticeItem } from "../../lib/transcript";
import type { LastTurnMeta, RpcTabState } from "../types";
import type { TabRuntime } from "./shared";

/** Minimum gap between mid-run usage snapshots. */
export const USAGE_REFRESH_MS = 500;

/** pi-ai's StreamTimeoutError classifier bit (Flag.Timeout, pi-ai error/flags.ts). */
const OMP_ERROR_FLAG_TIMEOUT = 0x0004_0000;
/** pi-ai's UsageLimit classifier bit (Flag.UsageLimit, pi-ai error/flags.ts). */
const OMP_ERROR_FLAG_USAGE_LIMIT = 0x0008_0000;
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
  | { phase: "after-commit"; type: "refresh-branch-diff" }
  | { phase: "after-commit"; type: "settle-browser-pane-close" }
  | { phase: "after-commit"; type: "rename-session" }
  | { phase: "after-commit"; type: "dispatch-early-title" }
  | { phase: "after-commit"; type: "arm-delegated-title"; prompt: string }
  | { phase: "after-commit"; type: "refresh-auto-title" }
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
  const count = tab.stallCount + 1;
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
 * True when omp's title digest can read this assistant message: omp 18.8.5's
 * digest keeps an assistant message only for non-empty text or thinking —
 * tool calls alone contribute nothing (issue #803).
 */
function carriesTitleDigest(message: unknown): boolean {
  const content = field(message, "content");
  if (typeof content === "string") return content.trim() !== "";
  return arrField(message, "content").some((block) => {
    const kind = strField(block, "type");
    const text =
      kind === "text"
        ? strField(block, "text")
        : kind === "thinking"
          ? strField(block, "thinking")
          : undefined;
    return text !== undefined && text.trim() !== "";
  });
}

/**
 * The quota chip's source event, or null when the frame says nothing about
 * rate windows (issue #673). `auto_retry_end` recoveries outrank the wait
 * signal: omp's retry layer records "credential" when a sibling rotation
 * unblocked the attempt and "wait" when a UsageLimit delay did. Mid-request
 * rotation the retry layer never records is structurally invisible here.
 */
function retryQuotaEvent(
  type: string | undefined,
  frame: object,
  now: number,
): { at: number; kind: "rotation" | "wait"; delayMs?: number } | null {
  if (type === "auto_retry_start") {
    if (((numField(frame, "errorId") ?? 0) & OMP_ERROR_FLAG_USAGE_LIMIT) === 0)
      return null;
    const delayMs = numField(frame, "delayMs");
    return {
      at: now,
      kind: "wait",
      ...(delayMs !== undefined && delayMs > 0 ? { delayMs } : {}),
    };
  }
  if (type !== "auto_retry_end") return null;
  let waited = false;
  for (const entry of arrField(frame, "retryErrors")) {
    const recovery = strField(field(entry, "retryRecovery"), "recovery");
    if (recovery === "credential") return { at: now, kind: "rotation" };
    if (recovery === "wait") waited = true;
  }
  return waited ? { at: now, kind: "wait" } : null;
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

  // Quota signal beside the stall signal (issue #673): a UsageLimit-bit
  // auto_retry_start means the retry layer is waiting on a rate window; an
  // auto_retry_end whose recorded recoveries name a credential switch means
  // a sibling rotation unblocked the turn. Pure frame reads — no new wire.
  const quotaEvent = retryQuotaEvent(type, frame, now);
  if (quotaEvent !== null) {
    rpc.quotaEvent = quotaEvent;
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
      // Under omp's automatic selector the frame carries `configured:"auto"`
      // and its thinkingLevel is a per-prompt classification output, not the
      // user's choice — paint the resolved level but NEVER persist it: that
      // would silently convert the session from auto to a pinned level and
      // re-pin it on the next resume. A frame without `configured` is a
      // concrete change (manual pick, TUI, cycle) and persists as before.
      const configured = strField(frame, "configured");
      const isAuto = configured === "auto";
      rpc.session = {
        ...tab.session,
        thinkingLevel,
        thinkingConfigured: isAuto ? "auto" : null,
      };
      hasRpcPatch = true;
      if (!isAuto && tab.model !== null)
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
    rpc.quotaEvent = undefined;
    rpc.activeTurnKeywords = [];
    runtimePatch.pendingTurnKeywords = [];
    runtimePatch.keywordInputBatchStarted = false;
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

  if (type === "turn_start") {
    runtimePatch.pendingTurnKeywords = [];
    runtimePatch.keywordInputBatchStarted = false;
  }

  if (type === "message_start") {
    const message = field(frame, "message");
    const role = strField(message, "role");
    if (role === "custom" && boolField(message, "display") === false) {
      const customType = strField(message, "customType");
      const keyword = MAGIC_KEYWORDS.find(({ id }) => customType === `${id}-notice`);
      if (keyword !== undefined && !runtime.pendingTurnKeywords.includes(keyword.word))
        runtimePatch.pendingTurnKeywords = [...runtime.pendingTurnKeywords, keyword.word];
    } else if (role === "user") {
      // Notices precede consumed inputs, not queue acceptance. Only the first
      // user in a turn's input batch replaces the previous input's effect.
      if (!runtime.keywordInputBatchStarted || runtime.pendingTurnKeywords.length > 0) {
        rpc.activeTurnKeywords = MAGIC_KEYWORDS
          .filter(({ word }) =>
            runtime.pendingTurnKeywords.includes(word) ||
            (runtime.keywordInputBatchStarted && tab.activeTurnKeywords.includes(word)),
          )
          .map(({ word }) => word);
        hasRpcPatch = true;
      }
      runtimePatch.pendingTurnKeywords = [];
      runtimePatch.keywordInputBatchStarted = true;
      // The user message is in omp's history from this frame (the ack
      // pre-dates the commit), so `/rename`'s digest is non-empty here:
      // the auto-title shot goes out while the first turn streams
      // (issue #795). Idempotent; the arm and latch gate the no-ops.
      if (tab.initialPrompt && !tab.hasRenamed)
        effects.push({ phase: "after-commit", type: "dispatch-early-title" });
    } else if (
      role === "custom" &&
      strField(message, "customType") === LIVE_DELEGATION_CUSTOM_TYPE
    ) {
      // A live voice request is omp's agent-attributed custom message, never
      // a user prompt, so no send path armed it (issue #803). Only the
      // renderer that started live voice arms, from the spoken text.
      const prompt = textFromContent(field(message, "content")).trim();
      if (
        runtime.liveVoiceOwner === true &&
        !tab.initialPrompt &&
        !tab.hasRenamed &&
        prompt !== ""
      )
        effects.push({ phase: "after-commit", type: "arm-delegated-title", prompt });
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
      // The delegated shot (issue #803): the first assistant message omp's
      // digest can read is the earliest frame `/rename` can title from.
      if (
        runtime.delegatedTitlePending === true &&
        tab.initialPrompt &&
        !tab.hasRenamed &&
        carriesTitleDigest(message)
      ) {
        runtimePatch.delegatedTitlePending = false;
        effects.push({ phase: "after-commit", type: "dispatch-early-title" });
      }
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
    rpc.activeTurnKeywords = [];
    runtimePatch.pendingTurnKeywords = [];
    runtimePatch.keywordInputBatchStarted = false;
    hasRpcPatch = true;
    if (tab.status === "running") {
      rpc.status = "ready";
      rpc.streamStallMs = undefined;
      hasRpcPatch = true;
    }
    // A still-pending delegated arm hands over to the turn end: the safety
    // net below fires it when no assistant message carried digest text.
    if (runtime.delegatedTitlePending === true) runtimePatch.delegatedTitlePending = false;
    if ((tab.initialPrompt && !tab.hasRenamed) || tab.titleAttempt !== null)
      effects.push({ phase: "after-commit", type: "rename-session" });
    effects.push({
      phase: "after-commit",
      type: "refresh-usage",
      settleQueue: true,
    });
    // A turn that committed mid-flight must not erase the pane's view of the
    // session's work (issue #711): re-read the repo's diff at turn end.
    effects.push({ phase: "after-commit", type: "refresh-branch-diff" });
    // A symmetric close deferred by a mid-turn detach settles here: the case
    // re-checks open + agent custody + detached, so this push is a no-op for
    // every tab whose agent never held the pane.
    effects.push({ phase: "after-commit", type: "settle-browser-pane-close" });

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

  // A `todo` init is omp's own replan-refresh trigger (issue #804): the
  // session's work has visibly taken a new shape, so an omp-ui-generated
  // title deserves a fresh generator pass. `op: "init"` and a `phases`
  // array mirror what omp's `onTodoResultDetails` validates before it
  // consults `op`; a `refine` or an errored call is not a replan. The
  // gates (marker, ladder, floor) live in `refreshAutoTitle`.
  if (
    type === "tool_execution_end" &&
    strField(frame, "toolName") === "todo" &&
    boolField(frame, "isError") !== true
  ) {
    const details = field(field(frame, "result"), "details");
    if (strField(details, "op") === "init" && Array.isArray(field(details, "phases")))
      effects.push({ phase: "after-commit", type: "refresh-auto-title" });
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
