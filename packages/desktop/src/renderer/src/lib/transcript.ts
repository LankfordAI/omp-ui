import { formatDuration } from "./duration";
import { stripAttachmentRoutingContext } from "./attachment-routing";
import { boolField, field, isObj, numField, str, strField } from "./fields";
import { splitResolvedMentionContext } from "./mentions";
import { splitDocumentContext, type DocumentRef } from "./document-context";
import { parseOmpDiff, type DiffRow } from "./omp-diff";
import { parseVaultDetails, type VaultToolDetails } from "@omp-ui/core/vault-shared";
import { FLEET_WAKE_CUSTOM_TYPE, parseFleetWakeCard, type FleetWakeCard } from "@omp-ui/core/fleet-wake";

export interface AdvisorNote {
  note: string;
  severity?: string;
  advisor?: string;
}

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  /** Resolved model-context paths removed from the visible prose. */
  fileMentions?: string[];
  /**
   * Image blocks on the message. omp re-encodes on ingest (a PNG comes back as
   * webp), so the mime type here is omp's, not the clipboard's.
   */
  images?: { data: string; mimeType: string }[];
  /** PDF Document Attachments parsed back out of the attached-documents block (ADR-0044). */
  documents?: DocumentRef[];
  /** Epoch ms the prompt was sent (live) or written (backfill); the catch-up digest windows off it (issue #273). */
  timestamp?: number;
}
export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  /** Thinking blocks omp marked as between-tool narration, presented as reply text (issue #884). */
  narration: string;
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
  /** OMP-reported upstream response id, retained only for receipt hover detail. */
  responseId?: string;
  /** OMP-reported routed provider behind an aggregator. */
  upstreamProvider?: string;
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
  status: "running" | "done" | "error" | "cancelled" | "aborted";
  /** tool_execution_start.intent — the human headline ("Reading hello.txt"). */
  intent?: string;
  resultText?: string;
  /** Image blocks from tool_result content, same shape as UserItem.images (issue #520).
   *  size/quality: generate_image details.images provenance, omp >= 18.4.0 (issue #672). */
  images?: { data: string; mimeType: string; size?: string; quality?: string }[];
  /** details.model — the image model the tool actually ran (generate_image, issue #672).
   *  Pre-18.4.0 transcripts carry the catalog model here, which is what omp itself
   *  displayed at the time; field presence is the gate, no version check. */
  imageModel?: string;
  /** tool_execution_update.partialResult text, while running. */
  partialText?: string;
  diff?: DiffRow[];
  /** edit/write details.path, or read details.meta.source.value. */
  path?: string;
  /** edit/write details.op. */
  op?: string;
  /** bash details.wallTimeMs. */
  wallTimeMs?: number;
  /** edit details.errorKind (omp 18.13.0+): why omp refused a failed edit; the card shows it only on error. */
  errorKind?: string;
  notes?: AdvisorNote[];
  /** omp-ui vault host tool result details (issue #767): the card and the rail's Vault notes read it. */
  vault?: VaultToolDetails;
  /** Model is still generating this call's args — no tool_execution_start yet (issue #97). */
  argsStreaming?: boolean;
  /** assistantMessageEvent.contentIndex, correlating stream deltas within one message. */
  streamIndex?: number;
  /** Accumulated raw args JSON while streaming in delta mode (issue #718);
   *  `args` carries the best-effort parse of it. toolcall_end replaces both
   *  with the authoritative toolCall, so this field never survives into a
   *  settled card. */
  argsText?: string;
  /** Epoch ms the card was created (live) or the carrying message was written (backfill); the catch-up digest windows off it (issue #273). */
  timestamp?: number;
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
  /**
   * The omp xdev mount notice collapsed to a count (issue #848): the raw
   * comma-list of `mcp__…` tool names is dropped; `count` is how many MCP
   * tools the notice announced. The view renders a View affordance that
   * opens the CapabilitiesViewer Tools tab instead of the wall.
   */
  mcpMount?: { count: number };
  /**
   * omp's spend-cap stop notice (`source: "cost-gate"`, level error; issue
   * #952). The view adds a button opening Settings → omp, whose Spend caps
   * section edits `session.maxCost`. omp's warning-level cost-gate notice
   * carries no flag.
   */
  costCap?: true;
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
  /** Epoch ms the marker fired; live markers only (backfill synthesizes none). The catch-up digest windows off it (issue #273). */
  timestamp?: number;
}
export interface PlanItem {
  kind: "plan";
  id: string;
  title: string;
  planFilePath: string;
  planAbsPath: string | null;
  /** Plan markdown snapshot read off disk; null until loaded or when unreadable. */
  text: string | null;
  /** `invalidated` = the validated source changed under review (§6), NOT a verdict. */
  status: "pending" | "executed" | "refined" | "invalidated";
}
export interface CommandItem {
  kind: "command";
  id: string;
  /** First word without the slash, e.g. "mcp". */
  name: string;
  /** Remainder of the line, may be "". */
  args: string;
  status: "running" | "done" | "failed" | "agent";
  /** rpc failure text when status === "failed". */
  error?: string;
  /** Concatenated command_output text; absent until a frame arrives. */
  output?: string;
}
/** One "!" composer command: omp's concurrent bash RPC, no model turn. */
export interface ShellItem {
  kind: "shell";
  id: string;
  /** The line after the leading "!", forwarded verbatim. */
  command: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** Response output; absent until the bash response lands. */
  output?: string;
  /** Absent on a cancelled run — omp omits exitCode there. */
  exitCode?: number;
  truncated?: boolean;
  /** omp's failure text when status === "failed". */
  error?: string;
  /** False only from a recorded excludeFromContext entry (omp-ui never sends it). */
  shared?: boolean;
  timestamp?: number;
}

/** A Fleet result or notice omp-ui posted into the dispatching session (#957). */
export interface FleetWakeItem {
  kind: "fleetWake";
  id: string;
  card: FleetWakeCard;
  text: string;
}

export type RenderItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | AdvisoryItem
  | NoticeItem
  | IrcItem
  | MarkerItem
  | PlanItem
  | CommandItem
  | ShellItem
  | FleetWakeItem;

let counter = 0;

/** Marker labels are hairlines — long provider errors get clipped. */
function truncateLabel(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * The omp xdev mount notice (`xd://: mounted a, b, c…`, source "xdev") carrying
 * MCP tools → the MCP-tool count it announces. Null for anything else —
 * including mounted lists with zero `mcp__` names, mixed segments
 * (`"mounted …; unmounted …"`), and every other notice — which all keep
 * their verbatim text (issue #848).
 */
export function mcpMountCount(text: string): { count: number } | null {
  const m = /^xd:\/\/: mounted ((?:[^,;]+)(?:, [^,;]+)*)$/.exec(text);
  if (m === null) return null;
  const names = m[1]!.split(", ").map((s) => s.trim());
  const mcp = names.filter((n) => n.startsWith("mcp__"));
  return mcp.length === 0 ? null : { count: mcp.length };
}

export function markerItem(label: string, tone?: MarkerItem["tone"], timestamp = Date.now()): MarkerItem {
  return { kind: "marker", id: `marker-${++counter}`, label, tone, timestamp };
}

export function noticeItem(text: string, level?: NoticeItem["level"]): NoticeItem {
  return { kind: "notice", id: `notice-${++counter}`, text, level };
}

export function commandItem(name: string, args: string): CommandItem {
  return { kind: "command", id: `command-${++counter}`, name, args, status: "running" };
}

export function shellItem(command: string): ShellItem {
  return { kind: "shell", id: `shell-${++counter}`, command, status: "running", timestamp: Date.now() };
}

/**
 * True while the transcript carries no exchange — only ambient notices,
 * markers, and command rows (a fresh session already holds the xd:// notice
 * and the thinking-level marker; a pre-prompt slash command is ambient, not
 * an exchange). Any other kind — user, assistant, tool, plan, advisory,
 * irc — means a conversation exists and the fresh-session hero must yield
 * to the full transcript.
 */
export function preExchange(items: readonly RenderItem[]): boolean {
  return items.every((i) => i.kind === "notice" || i.kind === "marker" || i.kind === "command");
}

/** One huge bash result must not make the whole search quadratic. */
const SEARCH_TEXT_LIMIT = 32_000;

/**
 * The text find-within searches inside one render item (issue #270) — the
 * kind's searchable fields joined by newlines, undefined/empty fields skipped.
 */
export function itemSearchText(item: RenderItem): string {
  const fields: (string | null | undefined)[] = [];
  switch (item.kind) {
    case "user":
      fields.push(item.text);
      break;
    case "assistant":
      fields.push(item.text, item.thinking);
      break;
    case "tool":
      fields.push(
        item.name,
        item.intent,
        typeof item.args === "string" ? item.args : JSON.stringify(item.args),
        item.path,
        item.op,
        item.resultText,
        item.partialText,
      );
      break;
    case "advisory":
      fields.push(...item.notes.flatMap((n) => [n.advisor, n.note]));
      break;
    case "notice":
      fields.push(item.text);
      break;
    case "irc":
      fields.push(item.from, item.text);
      break;
    case "marker":
      fields.push(item.label);
      break;
    case "plan":
      fields.push(item.title, item.text);
      break;
    case "command":
      fields.push(item.name, item.args, item.output, item.error);
      break;
    case "shell":
      fields.push(item.command, item.output, item.error);
      break;
    case "fleetWake":
      fields.push(item.card.title, item.card.machine, item.text);
      break;
  }
  const text = fields
    .filter((f): f is string => typeof f === "string" && f !== "")
    .join("\n");
  return text.length <= SEARCH_TEXT_LIMIT ? text : text.slice(0, SEARCH_TEXT_LIMIT);
}

/**
 * Find-within (issue #270): ids of the items holding `query` as a
 * case-insensitive literal substring, in transcript order — one entry per
 * matching item. A blank query matches nothing.
 */
export function findMatches(items: readonly RenderItem[], query: string): string[] {
  if (query.trim() === "") return [];
  const needle = query.toLowerCase();
  const out: string[] = [];
  for (const item of items) {
    if (itemSearchText(item).toLowerCase().includes(needle)) out.push(item.id);
  }
  return out;
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

/**
 * Settles every run-scoped item still active when the run itself ends.
 * Tool status records why work stopped; assistant streaming loses its caret
 * and liveness obligation regardless of the tool settlement reason.
 */
export function settleRunningItems(
  items: RenderItem[],
  settled: "cancelled" | "aborted" = "cancelled",
): RenderItem[] {
  const hasRunning = items.some(
    (item) =>
      (item.kind === "tool" && item.status === "running") ||
      (item.kind === "assistant" && item.streaming),
  );
  if (!hasRunning) return items;
  return items.map((item) => {
    if (item.kind === "tool" && item.status === "running") {
      return { ...item, status: settled };
    }
    if (item.kind === "assistant" && item.streaming) {
      return { ...item, streaming: false };
    }
    return item;
  });
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter(isObj) : [];
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Image blocks of a content payload: `data` required, `mimeType` defaults to image/png. */
function imagesFromContent(content: unknown): { data: string; mimeType: string }[] {
  const images: { data: string; mimeType: string }[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type !== "image") continue;
    const data = str(block.data);
    if (data === undefined) continue;
    images.push({ data, mimeType: str(block.mimeType) ?? "image/png" });
  }
  return images;
}

/** generate_image details.images: image blocks live in details, not content (issue #672). */
function imagesFromDetails(
  details: unknown,
): { data: string; mimeType: string; size?: string; quality?: string }[] {
  if (!isObj(details) || !Array.isArray(details.images)) return [];
  const out: { data: string; mimeType: string; size?: string; quality?: string }[] = [];
  for (const im of details.images) {
    if (!isObj(im)) continue;
    const data = str(im.data);
    if (data === undefined) continue;
    out.push({
      data,
      mimeType: str(im.mimeType) ?? "image/png",
      ...(str(im.size) !== undefined ? { size: str(im.size) } : {}),
      ...(str(im.quality) !== undefined ? { quality: str(im.quality) } : {}),
    });
  }
  return out;
}

/** Conditional images/imageModel — content blocks first, then generate_image details. */
function imagesField(content: unknown, details: unknown): Pick<ToolItem, "images" | "imageModel"> {
  let images = imagesFromContent(content);
  let imageModel: string | undefined;
  if (images.length === 0) {
    images = imagesFromDetails(details);
    if (images.length > 0) imageModel = strField(details, "model") ?? undefined;
  }
  return {
    ...(images.length > 0 ? { images } : {}),
    ...(imageModel !== undefined ? { imageModel } : {}),
  };
}

export function userContentFromContent(
  content: unknown,
): Pick<UserItem, "text" | "fileMentions" | "images" | "documents"> {
  const blocks = typeof content === "string" ? [] : contentBlocks(content);
  const rawText =
    typeof content === "string"
      ? content
      : blocks
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("\n");
  const images = imagesFromContent(content);
  const visibleText = stripAttachmentRoutingContext(rawText, images.length);
  // File blocks precede the document block on the wire, and the mention
  // splitter anchors its close at end-of-text — the document block must go
  // first or the file block would never parse as terminal.
  const { text: docless, documents } = splitDocumentContext(visibleText);
  const { text, paths } = splitResolvedMentionContext(docless);
  return {
    text,
    ...(paths.length > 0 ? { fileMentions: paths } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {}),
  };
}

/** Splits thinking blocks into pane text and omp-tagged narration (issue #884); narration joins double-newline. */
function thinkingSplitFromContent(content: unknown): { thinking: string; narration: string } {
  const thinking: string[] = [];
  const narration: string[] = [];
  for (const b of contentBlocks(content)) {
    if (b.type !== "thinking" || typeof b.thinking !== "string") continue;
    if (b.narration === true) narration.push(b.thinking);
    else thinking.push(b.thinking);
  }
  return { thinking: thinking.join("\n"), narration: narration.join("\n\n") };
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
    responseId: strField(message, "responseId"),
    upstreamProvider: strField(message, "upstreamProvider"),
    stopReason: strField(message, "stopReason"),
    durationMs: numField(message, "duration"),
    ttftMs: numField(message, "ttft"),
    timestamp: numField(message, "timestamp"),
  };
}

/** Per-tool `result.details`: edit/write carry `path`/`op` (a failed edit `errorKind`), read hides it under meta.source. */
function detailFacts(details: unknown): Pick<ToolItem, "path" | "op" | "wallTimeMs" | "errorKind"> {
  return {
    path:
      strField(details, "path") ??
      strField(field(field(details, "meta"), "source"), "value"),
    op: strField(details, "op"),
    wallTimeMs: numField(details, "wallTimeMs"),
    errorKind: strField(details, "errorKind"),
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

/**
 * Read the item at `index` with its kind proven: the caller's findIndex or
 * lastStreamingAssistant already matched it; this accessor is the proof the
 * type system needs, so no `as Item` cast stands between the lookup and the
 * update. `null` is the unreachable arm.
 */
function kindAt<K extends RenderItem["kind"]>(
  items: RenderItem[],
  index: number,
  kind: K,
): Extract<RenderItem, { kind: K }> | null {
  const item = items[index];
  if (item === undefined || item.kind !== kind) return null;
  return item as Extract<RenderItem, { kind: K }>;
}

function lastStreamingAssistant(items: RenderItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "assistant" && item.streaming) return i;
  }
  return -1;
}

/** Newest content-bearing item: markers, notices, and irc lines are ambient
 *  chrome and do not break the tail an advisor card left behind (issue #882). */
function lastContentItem(items: RenderItem[]): RenderItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const kind = items[i]!.kind;
    if (kind !== "marker" && kind !== "notice" && kind !== "irc") return items[i]!;
  }
  return null;
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

function isFleetWakeMessage(message: Record<string, unknown>): boolean {
  return message.role === "custom" && message.customType === FLEET_WAKE_CUSTOM_TYPE;
}

/** message_start and message_end both carry the wake message — one card per wakeId. */
function appendFleetWake(items: RenderItem[], message: Record<string, unknown>): RenderItem[] {
  if (!isFleetWakeMessage(message)) return items;
  const card = parseFleetWakeCard(message.details);
  if (card === null) return items;
  if (items.some((i) => i.kind === "fleetWake" && i.card.wakeId === card.wakeId)) return items;
  return [...items, { kind: "fleetWake", id: `fleet-wake-${++counter}`, card, text: textFromContent(message.content) }];
}

/** True while the open run holds nothing since its "agent started" marker but
 *  ambient chrome and the empty assistant message omp may emit before a custom one. */
function runHasNoContent(items: RenderItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "marker") {
      if (item.label === "agent started") return true;
      continue;
    }
    if (item.kind === "notice" || item.kind === "irc") continue;
    if (item.kind === "assistant" && item.text === "" && item.thinking === "" && item.narration === "") continue;
    return false;
  }
  return false;
}

/** Live frames: omp delivers an idle wake as agent_start, then the custom
 *  message — a card that opens its run gets the attribution marker. */
function appendLiveFleetWake(items: RenderItem[], message: Record<string, unknown>): RenderItem[] {
  const next = appendFleetWake(items, message);
  if (next === items || !runHasNoContent(items)) return next;
  return [...next, markerItem("fleet result started the run", "copper")];
}

/**
 * Folds toolcall_start/delta/end assistantMessageEvents into a running tool
 * card, so the transcript shows a write's content while the model generates
 * it (issue #97). Two stream shapes arrive depending on the runtime's
 * `messageUpdates` mode (issue #718): full frames carry a partial-parsed
 * `partial` snapshot per delta; delta frames carry only `toolcall_start`,
 * string fragments in `toolcall_delta.delta`, and the finished `toolCall` at
 * `toolcall_end` — accumulated here into `argsText` and parsed best-effort.
 * `toolcall_end` is authoritative in both modes.
 */
function parsePartialArgs(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to a structural repair — this is display-only, so an
    // unrepairable fragment is worth one retry, never a dropped draft.
  }
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") closers.pop();
  }
  const repaired = `${raw.replace(/,\s*$/, "")}${inString ? '"' : ""}${closers.reverse().join("")}`;
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

function reduceToolcallStream(
  items: RenderItem[],
  type: string,
  ame: Record<string, unknown>,
): RenderItem[] {
  const contentIndex = typeof ame.contentIndex === "number" ? ame.contentIndex : -1;
  if (contentIndex < 0) return items;
  const partial = isObj(ame.partial) ? ame.partial : null;
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const raw = type === "toolcall_end" && isObj(ame.toolCall) ? ame.toolCall : content[contentIndex];
  const block = isObj(raw) && raw.type === "toolCall" ? raw : null;
  // Delta-mode frames carry no snapshot block: the start opens the card,
  // the deltas accumulate the args fragment.
  const fragment =
    block === null && (type === "toolcall_start" || str(ame.delta) !== null)
      ? (str(ame.delta) ?? "")
      : null;
  if (block === null && fragment === null) return items;
  const callId = str(block?.id) ?? "";
  // A settled or cancelled card never matches — contentIndex only correlates
  // within the currently streaming assistant message.
  const idx = items.findIndex(
    (i) =>
      i.kind === "tool" &&
      i.status === "running" &&
      i.argsStreaming === true &&
      i.streamIndex === contentIndex,
  );
  if (idx === -1) {
    return [
      ...items,
      {
        kind: "tool",
        id: callId || `tool-${++counter}`,
        toolCallId: callId,
        name: str(block?.name) ?? "tool",
        args: fragment === null ? block?.arguments : parsePartialArgs(fragment),
        argsText: fragment ?? undefined,
        status: "running",
        argsStreaming: type !== "toolcall_end",
        streamIndex: contentIndex,
        timestamp: Date.now(),
      },
    ];
  }
  const item = kindAt(items, idx, "tool");
  if (item === null) return items;
  if (fragment !== null) {
    const argsText = (item.argsText ?? "") + fragment;
    const parsed = parsePartialArgs(argsText);
    return replaceAt(items, idx, {
      ...item,
      argsText,
      args: parsed === undefined ? item.args : parsed,
    });
  }
  // The snapshot/authoritative path replaces any accumulated fragment text.
  const { argsText: _argsText, ...settledItem } = item;
  return replaceAt(items, idx, {
    ...settledItem,
    // Some providers only deliver the real id/name in later frames.
    toolCallId: callId || item.toolCallId,
    name: str(block?.name) ?? item.name,
    args: block?.arguments,
    argsStreaming: type !== "toolcall_end",
  });
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
      if (isFleetWakeMessage(message)) return appendLiveFleetWake(items, message);
      const role = str(message.role);
      if (role === "user") {
        return [
          ...items,
          {
            kind: "user",
            id: `user-${++counter}`,
            ...userContentFromContent(message.content),
            timestamp: numField(message, "timestamp") ?? Date.now(),
          },
        ];
      }
      if (role === "assistant") {
        return [
          ...items,
          { kind: "assistant", id: `assistant-${++counter}`, text: "", thinking: "", narration: "", streaming: true },
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
              narration: "",
              streaming: true,
            },
          ];
        }
        const item = kindAt(items, idx, "assistant");
        if (item === null) return items;
        return replaceAt(items, idx, { ...item, text: item.text + delta });
      }
      if (type === "thinking_delta") {
        const idx = lastStreamingAssistant(items);
        if (idx === -1) return items;
        const item = kindAt(items, idx, "assistant");
        if (item === null) return items;
        return replaceAt(items, idx, { ...item, thinking: item.thinking + delta });
      }
      if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") {
        return reduceToolcallStream(items, type, ame);
      }
      return items;
    }

    case "message_end": {
      const message = isObj(event.message) ? event.message : null;
      if (message && isAdvisorMessage(message)) return appendAdvisory(items, message);
      if (message && isFleetWakeMessage(message)) return appendLiveFleetWake(items, message);
      // `providerPayload` also lives on the message and is megabytes wide —
      // only these accounting fields are ever lifted out of it.
      const meta = message && str(message.role) === "assistant" ? assistantMeta(message) : {};
      const idx = lastStreamingAssistant(items);
      if (idx !== -1) {
        const item = kindAt(items, idx, "assistant");
        if (item === null) return items;
        // The message's content is the authoritative rendering of the turn;
        // in delta mode (issue #718) the item's text is our own accumulation
        // of the deltas. Reconciling keeps the transcript right when a frame
        // was dropped or the coalescer merged one; empty authoritative text
        // (error- or interrupt-ended messages, tool-only turns) keeps what
        // did stream. A content-free message_end carries nothing to reconcile.
        let settled = item;
        const content = message !== null && "content" in message ? message.content : undefined;
        if (content !== undefined) {
          const text = textFromContent(content);
          // Narration streams as plain thinking_delta, so the streamed
          // item.thinking is contaminated — authoritative narration clears it.
          const { thinking, narration } = thinkingSplitFromContent(content);
          if (text !== "" && text !== item.text) settled = { ...settled, text };
          if (narration === "") {
            if (thinking !== "" && thinking !== item.thinking) settled = { ...settled, thinking };
          } else {
            settled = { ...settled, thinking, narration };
          }
          // One-off read: the node tsconfig (which type-checks this file via
          // a live test) lacks vite/client's ImportMeta typing; the renderer
          // build always defines it.
          const devBuild = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
          const streamedThinking = thinking + narration;
          if (
            devBuild &&
            ((text !== "" && text.replace(/\n/g, "") !== item.text.replace(/\n/g, "")) ||
              (streamedThinking !== "" &&
                streamedThinking.replace(/\n/g, "") !== item.thinking.replace(/\n/g, "")))
          ) {
            console.warn(
              "[transcript] message_end content disagrees with the streamed deltas — " +
                "a message_update frame was dropped or mis-merged",
            );
          }
        }
        return replaceAt(items, idx, { ...settled, ...meta, streaming: false });
      }
      // No streaming item (resumed mid-stream) — render the final message.
      if (message && str(message.role) === "assistant") {
        return [
          ...items,
          {
            kind: "assistant",
            id: `assistant-${++counter}`,
            text: textFromContent(message.content),
            ...thinkingSplitFromContent(message.content),
            streaming: false,
            ...meta,
          },
        ];
      }
      return items;
    }

    case "tool_execution_start": {
      const toolCallId = str(event.toolCallId) ?? `tool-${++counter}`;
      // The args-streaming phase (issue #97) already created this card — merge
      // into it so the transcript shows one card per call, in stream order.
      const idx = items.findIndex((i) => i.kind === "tool" && i.toolCallId === toolCallId);
      if (idx !== -1) {
        const item = kindAt(items, idx, "tool");
        if (item === null) return items;
        return replaceAt(items, idx, {
          ...item,
          name: str(event.toolName) ?? item.name,
          args: event.args ?? item.args,
          status: "running",
          intent: str(event.intent) ?? item.intent,
          argsStreaming: false,
        });
      }
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
          timestamp: Date.now(),
        },
      ];
    }

    case "tool_execution_update": {
      const toolCallId = str(event.toolCallId);
      const idx = toolCallId
        ? items.findIndex((i) => i.kind === "tool" && i.toolCallId === toolCallId)
        : -1;
      if (idx === -1) return items;
      const item = kindAt(items, idx, "tool");
      if (item === null) return items;
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
        vault: parseVaultDetails(details) ?? undefined,
        ...detailFacts(details),
        ...imagesField(result ? result.content : undefined, details),
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
      const item = kindAt(items, idx, "tool");
      if (item === null) return items;
      return replaceAt(items, idx, { ...item, ...patch });
    }

    case "agent_start": {
      // A fresh turn whose newest content is an advisor card is omp's
      // post-answer wake (advisor.continueSeverity, issue #882): say so —
      // a run that resumes itself with no explanation reads as a bug.
      if (lastContentItem(items)?.kind === "advisory") {
        return [...items, markerItem("advisor continued the run", "copper")];
      }
      return [...items, markerItem("agent started", "neutral")];
    }
    case "agent_end": {
      // The terminal assistant message of the turn carries the end reason: an
      // error end aborts running cards, a user interrupt or a clean end cancels.
      const lastAssistant = [...items].reverse().find((i) => i.kind === "assistant");
      const settled =
        lastAssistant?.kind === "assistant" && lastAssistant.stopReason === "error"
          ? "aborted"
          : "cancelled";
      return [...settleRunningItems(items, settled), markerItem("agent finished", "signal")];
    }
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
    case "auto_retry_start": {
      const attempt = numField(event, "attempt");
      const maxAttempts = numField(event, "maxAttempts");
      const delayMs = numField(event, "delayMs");
      const label =
        attempt !== undefined && maxAttempts !== undefined
          ? `auto-retry ${attempt}/${maxAttempts} started` +
            (delayMs !== undefined ? ` — retrying in ${formatDuration(delayMs)}` : "")
          : "auto-retry started";
      return [...items, markerItem(label, "copper")];
    }
    case "auto_retry_end": {
      const success = boolField(event, "success");
      if (success === true) return [...items, markerItem("retry succeeded", "signal")];
      if (success === false) {
        const finalError = strField(event, "finalError");
        return [...items, markerItem(`auto-retry failed${finalError ? `: ${truncateLabel(finalError)}` : ""}`, "rose")];
      }
      return [...items, markerItem("auto-retry finished", "copper")];
    }
    case "retry_fallback_applied": {
      const from = strField(event, "from");
      const to = strField(event, "to");
      return [
        ...items,
        markerItem(from && to ? `retry fallback: ${from} → ${to}` : "retry fallback applied", "copper"),
      ];
    }
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
      // Goal state lives on the HUD chip; subagent replays pass through here too.
      return items;

    case "notice": {
      const text = str(event.message) ?? str(event.text) ?? str(event.notice) ?? "";
      // The xdev mount notice's comma-list of tool names is the wall (issue
      // #848): collapse it to a structured count, text empty by design.
      const mcpMount = mcpMountCount(text);
      const level = NOTICE_LEVELS[str(event.level) ?? ""];
      const source = str(event.source);
      return [
        ...items,
        {
          ...noticeItem(mcpMount === null ? text : "", level),
          source,
          ...(mcpMount === null ? {} : { mcpMount }),
          ...(source === "cost-gate" && level === "error" ? { costCap: true as const } : {}),
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
    if (isFleetWakeMessage(raw)) {
      const next = appendFleetWake(items, raw);
      if (next !== items) items.push(next.at(-1)!);
      continue;
    }
    const role = str(raw.role);
    if (role === "user") {
      items.push({
        kind: "user",
        id: `user-${++counter}`,
        ...userContentFromContent(raw.content),
        timestamp: numField(raw, "timestamp"),
      });
      continue;
    }
    if (role === "assistant") {
      const { thinking, narration } = thinkingSplitFromContent(raw.content);
      items.push({
        kind: "assistant",
        id: `assistant-${++counter}`,
        text: textFromContent(raw.content),
        thinking,
        narration,
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
            timestamp: numField(raw, "timestamp"),
          });
        }
      }
      continue;
    }
    if (role === "bashExecution") {
      items.push({
        kind: "shell",
        id: `shell-${++counter}`,
        command: str(raw.command) ?? "",
        status: raw.cancelled === true ? "cancelled" : "done",
        output: str(raw.output) ?? "",
        exitCode: numField(raw, "exitCode"),
        truncated: raw.truncated === true,
        shared: raw.excludeFromContext !== true,
        timestamp: numField(raw, "timestamp"),
      });
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
        vault: parseVaultDetails(details) ?? undefined,
        ...detailFacts(details),
        ...imagesField(raw.content, details),
      };
    }
  }
  return items;
}
