import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { copyFallback } from "../lib/clipboard";
import { formatDuration } from "../lib/duration";
import { formatCost, tokenCount } from "../lib/format";
import { useTranscriptScale } from "../lib/text-scale";
import type {
  AssistantItem,
  CommandItem,
  IrcItem,
  MarkerItem,
  NoticeItem,
  RenderItem,
  UserItem,
} from "../lib/transcript";
import { useStore } from "../store";
import { ErrorBoundary } from "./ErrorBoundary";
import { Markdown } from "./Markdown";
import { PlanCard } from "./PlanCard";
import { AdvisoryNotes, ToolCard } from "./ToolCard";
import { TranscriptContextMenu } from "./TranscriptContextMenu";
import { Chip, Disclosure, Empty, Label, type Tone } from "./ui";

/** Re-entry threshold: this close to the tail still counts as following. */
const AT_BOTTOM_SLACK = 64;

/* ------------------------------------------------------------- assistant */

/**
 * The receipt: one dim line under a finished turn. It exists so cost and
 * latency are always answerable without opening a panel, which means it has
 * to stay quiet enough to ignore — hence one line, faint until hover.
 */
function UsageStrip({ item }: { item: AssistantItem }) {
  const usage = item.usage;
  if (!usage) return null;
  const parts: string[] = [];
  if (item.model) parts.push(item.model);
  parts.push(`↑${tokenCount(usage.input)}`, `↓${tokenCount(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`cache ${tokenCount(usage.cacheRead)}`);
  if (usage.cost > 0) parts.push(formatCost(usage.cost));
  if (item.ttftMs !== undefined && item.ttftMs > 0) parts.push(`ttft ${formatDuration(item.ttftMs)}`);
  if (item.durationMs !== undefined && item.durationMs > 0) parts.push(formatDuration(item.durationMs));
  if (item.stopReason && item.stopReason !== "end_turn" && item.stopReason !== "stop") {
    parts.push(item.stopReason);
  }
  // Wall-clock anchor: local short time inline, full locale date+time on hover.
  const at = item.timestamp === undefined ? null : new Date(item.timestamp);
  const atText = at?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const atTooltip = at?.toLocaleString();
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] tabular-nums text-ink-faint transition-colors hover:text-ink-dim"
      title={[item.provider, atTooltip].filter(Boolean).join(" · ") || undefined}
    >
      {parts.map((part, i) => (
        <span key={i}>{part}</span>
      ))}
      {at && (
        <>
          {" · "}
          <span title={atTooltip}>{atText}</span>
        </>
      )}
    </div>
  );
}

/** Pins to the tail while the model is still emitting reasoning. */
function ThinkingPane({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!live) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live, text]);
  return (
    <pre
      ref={ref}
      data-selectable
      className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-ink-dim"
    >
      {text}
    </pre>
  );
}

function AssistantBlock({ item }: { item: AssistantItem }) {
  // Reasoning is the only visible progress before the first token of prose.
  const working = item.streaming && item.text === "";
  const caret = item.streaming ? (
    <span className="animate-caret ml-px inline-block align-baseline font-mono text-signal">▍</span>
  ) : undefined;

  return (
    // `data-markdown-source` carries the turn's raw markdown so the selection
    // context menu can offer "Copy as Markdown" (issue #72); the attribute is
    // assistant-only, which is exactly the intended mapping.
    <div
      className="animate-rise space-y-1.5"
      data-markdown-source={item.text !== "" ? item.text : undefined}
    >
      {item.thinking !== "" && (
        <Disclosure
          // Remount on the working→answering flip so the pane auto-opens while
          // there is nothing else to watch, then folds once prose arrives —
          // without ever fighting a user who opened it by hand.
          key={working ? "live" : "idle"}
          defaultOpen={working}
          className="rounded-md border border-line-soft bg-sunken px-2 py-1"
          summary={<Label className="text-copper">thinking</Label>}
        >
          <ThinkingPane text={item.thinking} live={working} />
        </Disclosure>
      )}
      {(item.text !== "" || caret) && (
        <Markdown text={item.text} className="text-ink" trailing={caret} />
      )}
      <UsageStrip item={item} />
    </div>
  );
}

/* --------------------------------------------------------- selection menu */

/**
 * Selection state captured synchronously at contextmenu time (issue #72):
 * right-click must not clear the selection before the action reads it, and
 * holding the string makes the action immune even if it does.
 */
type TranscriptMenuState = { x: number; y: number; text: string; markdown: string | null };

/**
 * The turn's raw markdown when the selection starts inside assistant prose —
 * the only nodes carrying `data-markdown-source`. Tool cards, code blocks,
 * and thinking yield null, so "Copy as Markdown" hides there; that is the
 * issue's "where the selection maps cleanly onto a render item's source".
 */
function markdownSourceForSelection(sel: Selection): string | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const node = sel.getRangeAt(0).startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return el?.closest("[data-markdown-source]")?.getAttribute("data-markdown-source") ?? null;
}

/** Whether the selection's common ancestor lives under `root`. */
function selectionWithin(root: HTMLElement | null, sel: Selection): boolean {
  if (root === null || sel.rangeCount === 0) return false;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return el !== null && root.contains(el);
}

/* ------------------------------------------------------------ small kinds */

function UserBubble({ item, first }: { item: UserItem; first: boolean }) {
  const images = item.images ?? [];
  return (
    <div className="animate-rise flex flex-col items-end gap-1">
      {first && <Label>you</Label>}
      <div className="max-w-[72%] space-y-2 rounded-lg border border-iris-dim/40 bg-iris-wash px-3 py-2 text-ink">
        {item.text !== "" && <Markdown text={item.text} />}
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((image, i) => (
              <img
                // Index-keyed deliberately: a message's image list is fixed
                // once rendered, and the base64 payload is far too long a key.
                key={i}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`attached image ${i + 1}`}
                title={`${image.mimeType} — image ${i + 1} of ${images.length}`}
                className="max-h-40 rounded border border-line-strong bg-sunken object-contain"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const NOTICE_TONE: Record<string, Tone> = { error: "rose", warn: "copper", info: "neutral" };

/** Same failure surface the store uses for backend rejections. */
function alertBackendError(err: unknown): void {
  window.alert(err instanceof Error ? err.message : String(err));
}

function NoticeLine({ item }: { item: NoticeItem }) {
  const tone = NOTICE_TONE[item.level ?? "info"] ?? "neutral";
  // A notice carrying a path (the exported transcript HTML, issue #84) is a
  // link: the text opens the file with the system handler, the folder glyph
  // reveals it in the file manager.
  const path = item.path;
  return (
    <div className="animate-rise flex justify-center">
      <div
        className={cn(
          "flex max-w-[80%] items-center gap-1.5 rounded-2xl border px-2.5 py-1 text-[11px]",
          tone === "rose" && "border-rose-dim/50 bg-rose-wash text-rose",
          tone === "copper" && "border-copper-dim/50 bg-copper-wash text-copper",
          tone === "neutral" && "border-line bg-raised text-ink-dim",
        )}
      >
        {item.source && (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">{item.source}</span>
        )}
        {path === undefined ? (
          <span className="min-w-0 break-words" data-selectable>
            {item.text}
          </span>
        ) : (
          <>
            <button
              type="button"
              title={`open ${path}`}
              className="min-w-0 cursor-pointer break-words text-left underline decoration-dotted underline-offset-2 hover:text-ink"
              data-selectable
              onClick={() => void backend.openPath(path).catch(alertBackendError)}
            >
              {item.text}
            </button>
            <button
              type="button"
              title="reveal in file manager"
              aria-label="reveal in file manager"
              className="shrink-0 cursor-pointer text-ink-faint hover:text-ink"
              onClick={() => void backend.showPathInFolder(path).catch(alertBackendError)}
            >
              <svg viewBox="0 0 16 16" aria-hidden className="size-3">
                <path
                  d="M1.8 4.2a1 1 0 0 1 1-1h3.4l1.6 2h5.4a1 1 0 0 1 1 1v5.1a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function IrcLine({ item }: { item: IrcItem }) {
  return (
    <div className="animate-rise flex items-baseline gap-1.5 text-[11px] text-ink-dim">
      <Chip tone="iris" mono>
        {item.from}
      </Chip>
      <div className="min-w-0 flex-1">
        <Markdown text={item.text} className="text-[11px]" />
      </div>
    </div>
  );
}

const MARKER_TONE: Record<string, string> = {
  signal: "text-signal",
  copper: "text-copper",
  rose: "text-rose",
  neutral: "text-ink-faint",
};

function MarkerRule({ item, count }: { item: MarkerItem; count: number }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-line" />
      <span
        className={cn(
          "shrink-0 text-[10px] uppercase tracking-[0.14em]",
          MARKER_TONE[item.tone ?? "neutral"] ?? MARKER_TONE.neutral,
        )}
      >
        {item.label}
        {count > 1 && <span className="ml-1 tabular-nums opacity-70">×{count}</span>}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * omp refuses `/mcp reauth|unauth|reconnect|smithery-*` and `/mcp notifications`
 * outside its TUI client and answers on `command_output` (issue #243); match
 * omp's own wording rather than intercepting the command — the verb still
 * reaches omp verbatim, and if omp ever answers it over rpc this affordance
 * just stops appearing.
 */
const TUI_ONLY_REPLY = /\bthe TUI client\b/;

/** The line as the user ran it, which a handoff replays in omp's TUI. */
function commandLine(item: CommandItem): string {
  return item.args === "" ? `/${item.name}` : `/${item.name} ${item.args}`;
}

/**
 * Hands a refused verb to omp's own TUI in the tab's console drawer. Both
 * command surfaces render it — the transcript row and RpcTab's hero footer —
 * because a session's first input can be one of these verbs, and a lone
 * command row keeps the hero undocked. Absent in the subagent view, which owns
 * no tab to host the drawer, and on any reply omp did not refuse.
 */
export function TuiHandoffButton({ item, tabId }: { item: CommandItem; tabId?: string }) {
  const startTuiHandoff = useStore((s) => s.startTuiHandoff);
  if (tabId === undefined || item.output === undefined || !TUI_ONLY_REPLY.test(item.output))
    return null;
  return (
    <button
      type="button"
      className="mt-1.5 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-mid hover:text-ink"
      onClick={() => startTuiHandoff(tabId, commandLine(item))}
    >
      run in omp TUI
    </button>
  );
}

/**
 * One slash command as the user ran it: the literal line in a mono slab, plus
 * the smallest status affix that answers "did it finish?". `agent` gets no
 * affix — the agent turn it invoked renders right below and speaks for itself.
 */
function CommandRow({ item, tabId }: { item: CommandItem; tabId?: string }) {
  return (
    <div className="animate-rise rounded border border-line-soft bg-sunken px-2 py-1.5 font-mono text-[12px] leading-[1.55]">
      <div className="flex items-baseline gap-1.5">
        <span
          data-selectable
          className={cn(
            "min-w-0 break-words",
            item.status === "failed" ? "text-rose" : "text-ink",
          )}
        >
          {commandLine(item)}
        </span>
        {item.status === "running" && (
          <span className="animate-caret inline-block shrink-0 align-baseline text-signal">▍</span>
        )}
        {item.status === "done" && <span className="shrink-0 text-ink-faint">✓</span>}
      </div>
      {item.status === "failed" && item.error !== undefined && (
        <p
          data-selectable
          className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug text-rose"
        >
          {item.error}
        </p>
      )}
      {item.output !== undefined && (
        <pre
          data-selectable
          className="mt-1 overflow-auto whitespace-pre-wrap break-words text-ink-mid"
        >
          {item.output}
        </pre>
      )}
      <TuiHandoffButton item={item} tabId={tabId} />
    </div>
  );
}

/**
 * What a transcript row that threw during render collapses to. The message
 * itself is unrecoverable (same props → same throw), so this shows just enough
 * to report: the row died, and why.
 */
function BrokenRow({ error }: { error: Error }) {
  return (
    <div className="rounded-md border-l-[3px] border-rose-dim bg-rose-wash px-2.5 py-1.5">
      <Label className="text-rose">message failed to render</Label>
      <p
        data-selectable
        className="mt-1 break-words font-mono text-[11px] leading-snug text-ink-mid"
      >
        {error.message}
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- grouping */

/** `count` > 1 only for a collapsed run of identical markers. */
interface Row {
  item: RenderItem;
  count: number;
}

interface Run {
  key: string;
  speaker: string;
  rows: Row[];
}

const SPEAKER: Record<RenderItem["kind"], string> = {
  user: "user",
  assistant: "assistant",
  tool: "tool",
  advisory: "meta",
  notice: "meta",
  irc: "meta",
  marker: "meta",
  plan: "tool",
  command: "command",
};

function buildRuns(items: RenderItem[]): Run[] {
  const runs: Run[] = [];
  for (const item of items) {
    const last = runs.at(-1);
    const lastRow = last?.rows.at(-1);
    // Repeated turn/agent markers otherwise stack into a wall of hairlines.
    if (
      item.kind === "marker" &&
      lastRow?.item.kind === "marker" &&
      lastRow.item.label === item.label
    ) {
      lastRow.count++;
      continue;
    }
    const speaker = SPEAKER[item.kind];
    if (last && last.speaker === speaker) {
      last.rows.push({ item, count: 1 });
    } else {
      runs.push({ key: item.id, speaker, rows: [{ item, count: 1 }] });
    }
  }
  return runs;
}

/**
 * An assistant run "opens the exchange" when nothing assistant-voiced (its
 * own prose or its tool calls) precedes it since the last user prompt —
 * meta rows (markers, notices, irc) don't reset the exchange.
 */
function opensExchange(runs: Run[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const speaker = runs[i]!.speaker;
    if (speaker === "user") return true;
    if (speaker === "assistant" || speaker === "tool") return false;
  }
  return true;
}

/**
 * One transcript row. Memoized on the item's identity: `reduceEvent` copies
 * only the items it changes, so a tail-only stream update leaves every
 * historical row's props shallow-equal and skips its render entirely
 * (issue #187).
 */
const TranscriptRow = memo(function TranscriptRow({
  item,
  count,
  first,
  tabId,
}: {
  item: RenderItem;
  count: number;
  first: boolean;
  tabId?: string;
}) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} first={first} />;
    case "assistant":
      return <AssistantBlock item={item} />;
    case "tool":
      return <ToolCard item={item} tabId={tabId} />;
    case "advisory":
      return (
        <div className="animate-rise">
          <AdvisoryNotes notes={item.notes} />
        </div>
      );
    case "notice":
      return <NoticeLine item={item} />;
    case "irc":
      return <IrcLine item={item} />;
    case "marker":
      return <MarkerRule item={item} count={count} />;
    case "plan":
      return <PlanCard item={item} />;
    case "command":
      return <CommandRow item={item} tabId={tabId} />;
  }
});

/* ------------------------------------------------------------------ view */

export interface FindState {
  ids: string[]; // matched item ids, transcript order
  activeId: string; // the match to centre on
  nonce: number; // jump counter: changing it re-runs the scroll
}

export function TranscriptView({
  items,
  tabId,
  find = null,
}: {
  items: RenderItem[];
  /** Owns the tab's stream-stall field (issue #228); omitted for the
   *  read-only subagent view, which never shows the live indicator. */
  tabId?: string;
  /** In-session find (issue #270): matched ids, the active match, and a jump
   *  nonce. Null closes the wash without touching follow mode. */
  find?: FindState | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  // Last observed scrollTop, for scroll direction.
  const lastScrollTopRef = useRef(0);
  const [menu, setMenu] = useState<TranscriptMenuState | null>(null);

  function updateFollowing(value: boolean) {
    followingRef.current = value;
    setFollowing(value);
  }

  function pinToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Recording the clamped target in `lastScrollTopRef` makes this pin's own
    // scroll-event echo report `prev === current`, so it can never be read as
    // an upward user scroll — no separate echo guard is needed (a positional
    // one would swallow a genuine scroll back to the exact bottom and keep
    // follow mode off).
    lastScrollTopRef.current = el.scrollTop;
  }

  const runs = useMemo(() => buildRuns(items), [items]);
  const scale = useTranscriptScale();

  // Length alone misses streaming, which mutates the last item in place.
  const last = items.at(-1);
  const tailLength =
    last?.kind === "assistant"
      ? last.text.length + last.thinking.length
      : last?.kind === "tool"
        ? (last.partialText?.length ?? 0) + (last.resultText?.length ?? 0)
        : 0;

  // Follow mode is exited only by a deliberate upward user scroll; content
  // growth and resizes never exit it because they fire no scroll events and
  // scroll anchoring is disabled (`[overflow-anchor:none]` on the container is
  // load-bearing). A synchronous clamp (never `scrollIntoView`) is deliberate:
  // it cannot race Chromium's native scroll anchoring back and forth a few
  // pixels, so a streaming tail stays glued to the bottom instead of bobbing.
  useLayoutEffect(() => {
    if (!following) return;
    pinToBottom();
  }, [items.length, tailLength, following]);

  // Re-pin on layout changes that bypass `items`: tool-card expansion,
  // markdown/image re-layout, window resize. When not following the callback
  // does nothing, so the viewport stays put exactly as before.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) pinToBottom();
    });
    observer.observe(el); // clientHeight changes: window resize, zoom
    observer.observe(content); // content height changes: cards, images, markdown
    return () => observer.disconnect();
  }, []);
  // Find wash classes per row (issue #270). Memoized from the find state so a
  // stream tick that re-renders rows without a new find prop reuses the same
  // strings.
  const findClassById = useMemo(() => {
    if (find === null) return null;
    const map = new Map<string, string>();
    for (const id of find.ids) {
      map.set(id, id === find.activeId ? "find-hit find-hit-active" : "find-hit");
    }
    return map;
  }, [find?.ids, find?.activeId, find?.nonce]);

  // Jump to the active match. Keyed on the nonce (a ref guard keeps unrelated
  // re-renders no-ops); a nonce bump is the only trigger.
  const lastFindNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (find === null) return;
    const nonce = find.nonce;
    if (lastFindNonceRef.current === nonce) return;
    lastFindNonceRef.current = nonce;

    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    // A collapsed marker run renders only its first item: if the active id's
    // wrapper is missing, walk backwards to the nearest rendered row.
    const activeIndex = items.findIndex((item) => item.id === find.activeId);
    const start = activeIndex === -1 ? items.length - 1 : activeIndex;
    let target: Element | null = null;
    for (let i = start; i >= 0; i -= 1) {
      const id = items[i]?.id;
      if (!id) continue;
      target = scrollEl.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
      if (target !== null) break;
    }
    if (target === null) return;

    // Follow-mode contract (issue #7): a target that is not the last row
    // means the user is now reading mid-transcript — exit follow mode before
    // scrolling so the "jump to latest" pill appears. The last row leaves
    // the mode untouched.
    const rows = scrollEl.querySelectorAll("[data-item-id]");
    if (rows.length > 0 && rows[rows.length - 1] !== target) {
      updateFollowing(false);
    }
    target.scrollIntoView({ block: "center" });
  }, [find?.nonce]);

  return (
    <div className="ambient relative min-h-0 flex-1 bg-surface">
      <div
        ref={scrollRef}
        onContextMenu={(event) => {
          // A second right-click while the menu is open dismisses it.
          if (menu !== null) {
            setMenu(null);
            return;
          }
          const sel = window.getSelection();
          if (sel === null || sel.isCollapsed) return;
          const text = sel.toString();
          if (text === "") return;
          if (!selectionWithin(scrollRef.current, sel)) return;
          const anchor = sel.anchorNode;
          const anchorEl =
            anchor === null
              ? null
              : anchor.nodeType === Node.TEXT_NODE
                ? anchor.parentElement
                : (anchor as HTMLElement);
          if (!anchorEl?.closest("[data-selectable]")) return;
          // No selection → fall through untouched (issue #72). preventDefault
          // keeps Chromium from clearing the selection before the action
          // reads it; the captured string makes the action immune regardless.
          event.preventDefault();
          setMenu({
            x: event.clientX,
            y: event.clientY,
            text,
            markdown: markdownSourceForSelection(sel),
          });
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const prev = lastScrollTopRef.current;
          lastScrollTopRef.current = el.scrollTop;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (distance <= AT_BOTTOM_SLACK) {
            updateFollowing(true); // reached the bottom: resume following
          } else if (el.scrollTop < prev) {
            updateFollowing(false); // deliberate scroll away from the tail
          }
          // Downward scroll not yet at the bottom: leave the mode unchanged.
        }}
        className="transcript-scroll h-full overflow-y-auto px-4 py-4 [overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          className="mx-auto flex max-w-4xl flex-col gap-5"
          // Transcript-scoped text size (issue #30): `zoom` scales every px
          // value inside the document surface — markdown, tool cards, slabs —
          // while the chrome around it stays fixed. The ResizeObserver above
          // sees the resulting content-height change and re-pins.
          style={{ zoom: scale }}
        >
          {items.length === 0 && (
            <Empty title="Nothing yet" hint="Send a prompt to start the session." />
          )}

          {runs.map((run, runIndex) => (
            <div
              key={run.key}
              className={cn("flex flex-col", run.speaker === "meta" ? "gap-1" : "gap-1.5")}
            >
              {/* The assistant's hanging speaker label, mirroring the user's
                  "you" (issue #32): with turn markers deliberately absent, this
                  is the quiet cue that a new exchange begins. Only the run
                  that opens the exchange gets it — assistant fragments after
                  a tool run are the same reply, and labeling each one would
                  rebuild the marker-noise problem the markers solved. */}
              {run.speaker === "assistant" && opensExchange(runs, runIndex) && (
                <Label>assistant</Label>
              )}
              {run.rows.map(({ item, count }, i) => {
                const findClass = findClassById?.get(item.id);
                return (
                  <div key={item.id} data-item-id={item.id} className={findClass}>
                    <ErrorBoundary fallback={(error) => <BrokenRow error={error} />}>
                      <TranscriptRow item={item} count={count} first={i === 0} tabId={tabId} />
                    </ErrorBoundary>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Reading-depth cue: content falls away under the pane's top hairline.
          Overlay, not background — the scroll container's own background would
          scroll with the content. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-void/25 to-transparent"
      />
      {!following && items.length > 0 && (
        <button
          type="button"
          onClick={() => updateFollowing(true)}
          className="edge-lit animate-rise absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-overlay px-3 py-1 text-[11px] text-ink-mid transition-colors hover:text-ink"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden
            className="size-3"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 3v9M4.5 8.5L8 12l3.5-3.5" />
          </svg>
          jump to latest
        </button>
      )}

      {menu !== null && (
        <TranscriptContextMenu
          x={menu.x}
          y={menu.y}
          markdown={menu.markdown}
          // copyFallback (not navigator.clipboard) so remote clients over
          // http://<lan-ip> without the async Clipboard API still work (#37).
          onCopy={() => void copyFallback(menu.text)}
          onCopyMarkdown={
            menu.markdown === null ? null : () => void copyFallback(menu.markdown!)
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
