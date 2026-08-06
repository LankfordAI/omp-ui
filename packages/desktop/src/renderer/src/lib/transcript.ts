import { field, numField, strField } from "./fields";
import { parseOmpDiff, type DiffRow } from "./omp-diff";

export interface AdvisorNote {
  note: string;
  severity?: string;
  advisor?: string;
}

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  /**
   * Image blocks on the message. omp re-encodes on ingest (a PNG comes back as
   * webp), so the mime type here is omp's, not the clipboard's.
   */
  images?: { data: string; mimeType: string }[];
}
export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
  /** message_end only — absent while streaming. */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
  };
  model?: string;
  provider?: string;
  stopReason?: string;
  durationMs?: number;
  ttftMs?: number;
  /** When the turn completed — epoch ms off the assistant message. */
  timestamp?: number;
}
export interface ToolItem {
  kind: "tool";
  id: string;
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "done" | "error" | "cancelled";
  /** tool_execution_start.intent — the human headline ("Reading hello.txt"). */
  intent?: string;
  resultText?: string;
  /** tool_execution_update.partialResult text, while running. */
  partialText?: string;
  diff?: DiffRow[];
  /** edit/write details.path, or read details.meta.source.value. */
  path?: string;
  /** edit/write details.op. */
  op?: string;
  /** bash details.wallTimeMs. */
  wallTimeMs?: number;
  notes?: AdvisorNote[];
}
export interface AdvisoryItem {
  kind: "advisory";
  id: string;
  notes: AdvisorNote[];
}
export interface NoticeItem {
  kind: "notice";
  id: string;
  text: string;
  level?: "info" | "warn" | "error";
  source?: string;
  /**
   * Absolute path of the artifact the notice announces (the exported
   * transcript HTML, issue #84). Structured so the view can offer
   * open/reveal actions without parsing the path back out of the text.
   */
  path?: string;
}
export interface IrcItem {
  kind: "irc";
  id: string;
  from: string;
  text: string;
}
export interface MarkerItem {
  kind: "marker";
  id: string;
  label: string;
  tone?: "neutral" | "signal" | "copper" | "rose";
}
export interface PlanItem {
  kind: "plan";
  id: string;
  title: string;
  planFilePath: string;
  planAbsPath: string | null;
  /** Plan markdown snapshot read off disk; null until loaded or when unreadable. */
  text: string | null;
  status: "pending" | "executed" | "refined";
}

export type RenderItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | AdvisoryItem
  | NoticeItem
  | IrcItem
  | MarkerItem
  | PlanItem;

let counter = 0;
export function markerItem(label: string, tone?: MarkerItem["tone"]): MarkerItem {
  return { kind: "marker", id: `marker-${++counter}`, label, tone };
}

export function noticeItem(text: string, level?: NoticeItem["level"]): NoticeItem {
  return { kind: "notice", id: `notice-${++counter}`, text, level };
}

export function planProposalItem(
  title: string,
  planFilePath: string,
  planAbsPath: string | null,
): PlanItem {
  return {
    kind: "plan",
    id: `plan-${++counter}`,
    title,
    planFilePath,
    planAbsPath,
    text: null,
    status: "pending",
  };
}

/** Settles tool cards still running when the run itself ends (abort, process death). */
export function settleRunningTools(items: RenderItem[]): RenderItem[] {
  if (!items.some((i) => i.kind === "tool" && i.status === "running")) return items;
  return items.map((i) =>
    i.kind === "tool" && i.status === "running" ? { ...i, status: "cancelled" as const } : i,
  );
}

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter(isObj) : [];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Image blocks off a user message. Returns undefined rather than an empty array
 * so a text-only message carries no key at all — `UserItem` is compared by
 * identity in places, and an always-present `[]` would be noise.
 */
function imagesFromContent(content: unknown): UserItem["images"] {
  const images: NonNullable<UserItem["images"]> = [];
  for (const block of contentBlocks(content)) {
    if (block.type !== "image") continue;
    const data = str(block.data);
    if (data === undefined) continue;
    images.push({ data, mimeType: str(block.mimeType) ?? "image/png" });
  }
  return images.length > 0 ? images : undefined;
}

function thinkingFromContent(content: unknown): string {
  return contentBlocks(content)
    .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking as string)
    .join("\n");
}

/**
 * The accounting tail of an assistant `message_end`. Deliberately narrow: the
 * same message carries `providerPayload`, a multi-megabyte raw response that
 * must never reach a render item.
 */
function assistantMeta(message: Record<string, unknown>): Partial<AssistantItem> {
  const usageRaw = field(message, "usage");
  const usage =
    usageRaw !== null && typeof usageRaw === "object"
      ? {
          input: numField(usageRaw, "input") ?? 0,
          output: numField(usageRaw, "output") ?? 0,
          cacheRead: numField(usageRaw, "cacheRead") ?? 0,
          cacheWrite: numField(usageRaw, "cacheWrite") ?? 0,
          total: numField(usageRaw, "totalTokens") ?? 0,
          cost: numField(field(usageRaw, "cost"), "total") ?? 0,
        }
      : undefined;
  return {
    usage,
    model: strField(message, "model"),
    provider: strField(message, "provider"),
    stopReason: strField(message, "stopReason"),
    durationMs: numField(message, "duration"),
    ttftMs: numField(message, "ttft"),
    timestamp: numField(message, "timestamp"),
  };
}

/** Per-tool `result.details`: edit/write carry `path`/`op`, read hides it under meta.source. */
function detailFacts(details: unknown): Pick<ToolItem, "path" | "op" | "wallTimeMs"> {
  return {
    path:
      strField(details, "path") ??
      strField(field(field(details, "meta"), "source"), "value"),
    op: strField(details, "op"),
    wallTimeMs: numField(details, "wallTimeMs"),
  };
}

/** Port of omp's isAdvisorCard — render from details.notes, never the XML. */
export function isAdvisorMessage(message: Record<string, unknown>): boolean {
  return message.role === "custom" && message.customType === "advisor";
}

function notesFromDetails(details: unknown): AdvisorNote[] {
  if (!isObj(details) || !Array.isArray(details.notes)) return [];
  return details.notes
    .filter(isObj)
    .map((n) => ({ note: str(n.note) ?? "", severity: str(n.severity), advisor: str(n.advisor) }))
    .filter((n) => n.note.length > 0);
}

/** omp says "warning"; the render surface says "warn". Unknown levels drop. */
const NOTICE_LEVELS: Record<string, NoticeItem["level"] | undefined> = {
  info: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
};

const warnedTypes = new Set<string>();
function warnOnce(type: string): void {
  if (warnedTypes.has(type)) return;
  warnedTypes.add(type);
  console.warn(`[transcript] ignoring unknown event type: ${type}`);
}

function replaceAt(items: RenderItem[], index: number, item: RenderItem): RenderItem[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function lastStreamingAssistant(items: RenderItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "assistant" && item.streaming) return i;
  }
  return -1;
}

function appendAdvisory(items: RenderItem[], message: Record<string, unknown>): RenderItem[] {
  const notes = notesFromDetails(message.details);
  if (notes.length === 0) return items;
  // message_start and message_end both carry the advisor message — one card.
  const last = items.at(-1);
  if (last?.kind === "advisory" && JSON.stringify(last.notes) === JSON.stringify(notes)) {
    return items;
  }
  return [...items, { kind: "advisory", id: `advisory-${++counter}`, notes }];
}

/**
 * Folds one AgentSessionEvent (or rpc control frame passed through) into the
 * render items. Unknown event types append nothing and warn once per type —
 * new upstream events must never break the transcript.
 */
export function reduceEvent(items: RenderItem[], event: unknown): RenderItem[] {
  if (!isObj(event) || typeof event.type !== "string") return items;
  switch (event.type) {
    case "message_start": {
      const message = isObj(event.message) ? event.message : null;
      if (!message) return items;
      if (isAdvisorMessage(message)) return appendAdvisory(items, message);
      const role = str(message.role);
      if (role === "user") {
        return [
          ...items,
          {
            kind: "user",
            id: `user-${++counter}`,
            text: textFromContent(message.content),
            images: imagesFromContent(message.content),
          },
        ];
      }
      if (role === "assistant") {
        return [
          ...items,
          { kind: "assistant", id: `assistant-${++counter}`, text: "", thinking: "", streaming: true },
        ];
      }
      return items;
    }

    case "message_update": {
      const ame = isObj(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
      if (!ame) return items;
      const type = str(ame.type);
      const delta = str(ame.delta) ?? str(ame.text) ?? "";
      if (type === "text_delta") {
        const idx = lastStreamingAssistant(items);
        if (idx === -1) {
          return [
            ...items,
            {
              kind: "assistant",
              id: `assistant-${++counter}`,
              text: delta,
              thinking: "",
              streaming: true,
            },
          ];
        }
        const item = items[idx] as AssistantItem;
        return replaceAt(items, idx, { ...item, text: item.text + delta });
      }
      if (type === "thinking_delta") {
        const idx = lastStreamingAssistant(items);
        if (idx === -1) return items;
        const item = items[idx] as AssistantItem;
        return replaceAt(items, idx, { ...item, thinking: item.thinking + delta });
      }
      return items;
    }

    case "message_end": {
      const message = isObj(event.message) ? event.message : null;
      if (message && isAdvisorMessage(message)) return appendAdvisory(items, message);
      // `providerPayload` also lives on the message and is megabytes wide —
      // only these accounting fields are ever lifted out of it.
      const meta = message && str(message.role) === "assistant" ? assistantMeta(message) : {};
      const idx = lastStreamingAssistant(items);
      if (idx !== -1) {
        const item = items[idx] as AssistantItem;
        return replaceAt(items, idx, { ...item, ...meta, streaming: false });
      }
      // No streaming item (resumed mid-stream) — render the final message.
      if (message && str(message.role) === "assistant") {
        return [
          ...items,
          {
            kind: "assistant",
            id: `assistant-${++counter}`,
            text: textFromContent(message.content),
            thinking: thinkingFromContent(message.content),
            streaming: false,
            ...meta,
          },
        ];
      }
      return items;
    }

    case "tool_execution_start": {
      const toolCallId = str(event.toolCallId) ?? `tool-${++counter}`;
      return [
        ...items,
        {
          kind: "tool",
          id: toolCallId,
          toolCallId,
          name: str(event.toolName) ?? "tool",
          args: event.args,
          status: "running",
          intent: str(event.intent),
        },
      ];
    }

    case "tool_execution_update": {
      const toolCallId = str(event.toolCallId);
      const idx = toolCallId
        ? items.findIndex((i) => i.kind === "tool" && i.toolCallId === toolCallId)
        : -1;
      if (idx === -1) return items;
      const item = items[idx] as ToolItem;
      const partial = isObj(event.partialResult) ? event.partialResult : null;
      const partialText = partial ? textFromContent(partial.content) : "";
      // Status stays `running` — an update is progress, never completion.
      if (!partialText) return items;
      return replaceAt(items, idx, { ...item, partialText });
    }

    case "tool_execution_end": {
      const toolCallId = str(event.toolCallId);
      const result = isObj(event.result) ? event.result : null;
      const details = result && isObj(result.details) ? result.details : null;
      const diffText = details && typeof details.diff === "string" ? details.diff : undefined;
      const notes = result ? notesFromDetails(result.details) : [];
      const patch = {
        status: (event.isError === true ? "error" : "done") as ToolItem["status"],
        resultText: result ? textFromContent(result.content) : undefined,
        diff: diffText ? parseOmpDiff(diffText) : undefined,
        notes: notes.length > 0 ? notes : undefined,
        ...detailFacts(details),
      };
      const idx = toolCallId
        ? items.findIndex((i) => i.kind === "tool" && i.toolCallId === toolCallId)
        : -1;
      if (idx === -1) {
        const id = toolCallId ?? `tool-${++counter}`;
        return [
          ...items,
          {
            kind: "tool",
            id,
            toolCallId: id,
            name: str(event.toolName) ?? "tool",
            args: undefined,
            ...patch,
          },
        ];
      }
      const item = items[idx] as ToolItem;
      return replaceAt(items, idx, { ...item, ...patch });
    }

    case "agent_start":
      return [...items, markerItem("agent started", "neutral")];
    case "agent_end":
      return [...settleRunningTools(items), markerItem("agent finished", "signal")];
    // Turn boundaries are pure ceremony in a rendered transcript: one prompt
    // produced eight of them in a live smoke test, drowning the actual content.
    // The tool-call/assistant cards already show where each turn's work went,
    // and agent_start/agent_end still bracket the exchange.
    case "turn_start":
    case "turn_end":
      return items;
    case "auto_compaction_start":
      return [...items, markerItem("auto-compaction started", "copper")];
    case "auto_compaction_end":
      return [...items, markerItem("auto-compaction finished", "copper")];
    case "auto_retry_start":
      return [...items, markerItem("auto-retry started", "copper")];
    case "auto_retry_end":
      return [...items, markerItem("auto-retry finished", "copper")];
    case "retry_fallback_applied":
      return [...items, markerItem("retry fallback applied", "copper")];
    // omp emits `retry_fallback_succeeded`; `retry_succeeded` is the older name.
    case "retry_fallback_succeeded":
    case "retry_succeeded":
      return [...items, markerItem("retry succeeded", "signal")];
    case "todo_reminder":
      return [...items, markerItem("todo reminder", "copper")];
    case "todo_auto_clear":
      return [...items, markerItem("todos cleared")];
    case "ttsr_triggered": {
      const rules = Array.isArray(event.rules) ? event.rules : [];
      const named = rules.map((r) => str(field(r, "name")) ?? "?").join(", ");
      return [
        ...items,
        markerItem(named ? `rule interrupt: ${named}` : "rule interrupt", "copper"),
      ];
    }
    case "thinking_level_changed":
      return [
        ...items,
        markerItem(`thinking level: ${str(event.thinkingLevel) ?? str(event.level) ?? "?"}`),
      ];
    case "goal_updated":
      return [...items, markerItem("goal updated")];

    case "notice": {
      const text = str(event.message) ?? str(event.text) ?? str(event.notice) ?? "";
      return [
        ...items,
        {
          ...noticeItem(text, NOTICE_LEVELS[str(event.level) ?? ""]),
          source: str(event.source),
        },
      ];
    }

    case "irc_message": {
      // The payload is a CustomMessage: `from`/`message` live under `details`.
      const message = isObj(event.message) ? event.message : null;
      const details = message && isObj(message.details) ? message.details : null;
      return [
        ...items,
        {
          kind: "irc",
          id: `irc-${++counter}`,
          from: str(details?.from) ?? str(event.from) ?? str(event.nick) ?? "irc",
          text:
            str(details?.message) ??
            str(details?.body) ??
            (message ? textFromContent(message.content) : undefined) ??
            str(event.text) ??
            "",
        },
      ];
    }

    default:
      warnOnce(event.type);
      return items;
  }
}

/** get_messages → render items; tool calls pair with their toolResults. */
export function historyToItems(messages: unknown[]): RenderItem[] {
  const items: RenderItem[] = [];
  const toolIndex = new Map<string, number>();
  for (const raw of messages) {
    if (!isObj(raw)) continue;
    if (isAdvisorMessage(raw)) {
      const notes = notesFromDetails(raw.details);
      if (notes.length > 0) items.push({ kind: "advisory", id: `advisory-${++counter}`, notes });
      continue;
    }
    const role = str(raw.role);
    if (role === "user") {
      items.push({
        kind: "user",
        id: `user-${++counter}`,
        text: textFromContent(raw.content),
        images: imagesFromContent(raw.content),
      });
      continue;
    }
    if (role === "assistant") {
      items.push({
        kind: "assistant",
        id: `assistant-${++counter}`,
        text: textFromContent(raw.content),
        thinking: thinkingFromContent(raw.content),
        streaming: false,
        ...assistantMeta(raw),
      });
      for (const block of contentBlocks(raw.content)) {
        if (block.type === "toolCall") {
          const toolCallId = str(block.id) ?? `tool-${++counter}`;
          toolIndex.set(toolCallId, items.length);
          items.push({
            kind: "tool",
            id: toolCallId,
            toolCallId,
            name: str(block.name) ?? "tool",
            args: block.arguments,
            status: "done",
          });
        }
      }
      continue;
    }
    if (role === "toolResult") {
      const toolCallId = str(raw.toolCallId);
      const idx = toolCallId ? toolIndex.get(toolCallId) : undefined;
      if (idx === undefined) continue;
      const item = items[idx]!;
      if (item.kind !== "tool") continue;
      const details = isObj(raw.details) ? raw.details : null;
      const diffText = details && typeof details.diff === "string" ? details.diff : undefined;
      const notes = notesFromDetails(raw.details);
      items[idx] = {
        ...item,
        status: raw.isError === true ? "error" : "done",
        resultText: textFromContent(raw.content),
        diff: diffText ? parseOmpDiff(diffText) : undefined,
        notes: notes.length > 0 ? notes : undefined,
        ...detailFacts(details),
      };
    }
  }
  return items;
}
