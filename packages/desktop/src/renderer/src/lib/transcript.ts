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
}
export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
}
export interface ToolItem {
  kind: "tool";
  id: string;
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "done" | "error";
  resultText?: string;
  diff?: DiffRow[];
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
}

export type RenderItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | AdvisoryItem
  | NoticeItem
  | IrcItem
  | MarkerItem;

let counter = 0;
export function markerItem(label: string): MarkerItem {
  return { kind: "marker", id: `marker-${++counter}`, label };
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

function thinkingFromContent(content: unknown): string {
  return contentBlocks(content)
    .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking as string)
    .join("\n");
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
          { kind: "user", id: `user-${++counter}`, text: textFromContent(message.content) },
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
      const idx = lastStreamingAssistant(items);
      if (idx !== -1) {
        const item = items[idx] as AssistantItem;
        return replaceAt(items, idx, { ...item, streaming: false });
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
        },
      ];
    }

    case "tool_execution_update":
      // Partial args/results streaming — v0 renders on end.
      return items;

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
      return [...items, markerItem("agent started")];
    case "agent_end":
      return [...items, markerItem("agent finished")];
    case "turn_start":
      return [...items, markerItem("turn started")];
    case "turn_end":
      return [...items, markerItem("turn finished")];
    case "auto_compaction_start":
      return [...items, markerItem("auto-compaction started")];
    case "auto_compaction_end":
      return [...items, markerItem("auto-compaction finished")];
    case "auto_retry_start":
      return [...items, markerItem("auto-retry started")];
    case "auto_retry_end":
      return [...items, markerItem("auto-retry finished")];
    case "retry_fallback_applied":
      return [...items, markerItem("retry fallback applied")];
    case "retry_succeeded":
      return [...items, markerItem("retry succeeded")];
    case "todo_reminder":
      return [...items, markerItem("todo reminder")];
    case "todo_auto_clear":
      return [...items, markerItem("todos cleared")];
    case "thinking_level_changed":
      return [
        ...items,
        markerItem(`thinking level: ${str(event.level) ?? str(event.thinkingLevel) ?? "?"}`),
      ];
    case "goal_updated":
      return [...items, markerItem("goal updated")];

    case "notice": {
      const text = str(event.message) ?? str(event.text) ?? str(event.notice) ?? "";
      return [...items, { kind: "notice", id: `notice-${++counter}`, text }];
    }

    case "irc_message": {
      return [
        ...items,
        {
          kind: "irc",
          id: `irc-${++counter}`,
          from: str(event.from) ?? str(event.nick) ?? "irc",
          text: str(event.text) ?? str(event.message) ?? "",
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
      items.push({ kind: "user", id: `user-${++counter}`, text: textFromContent(raw.content) });
      continue;
    }
    if (role === "assistant") {
      items.push({
        kind: "assistant",
        id: `assistant-${++counter}`,
        text: textFromContent(raw.content),
        thinking: thinkingFromContent(raw.content),
        streaming: false,
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
      };
    }
  }
  return items;
}
