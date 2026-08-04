import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import { useTranscriptScale } from "../lib/text-scale";
import type {
  AssistantItem,
  IrcItem,
  MarkerItem,
  NoticeItem,
  RenderItem,
  UserItem,
} from "../lib/transcript";
import { ErrorBoundary } from "./ErrorBoundary";
import { Markdown } from "./Markdown";
import { AdvisoryNotes, ToolCard, formatDuration } from "./ToolCard";
import { Chip, Disclosure, Empty, Label, type Tone } from "./ui";

/** Re-entry threshold: this close to the tail still counts as following. */
const AT_BOTTOM_SLACK = 64;

/* ------------------------------------------------------------- assistant */

function tokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

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
  parts.push(`↑${tokens(usage.input)}`, `↓${tokens(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`cache ${tokens(usage.cacheRead)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (item.ttftMs !== undefined && item.ttftMs > 0) parts.push(`ttft ${formatDuration(item.ttftMs)}`);
  if (item.durationMs !== undefined && item.durationMs > 0) parts.push(formatDuration(item.durationMs));
  if (item.stopReason && item.stopReason !== "end_turn" && item.stopReason !== "stop") {
    parts.push(item.stopReason);
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] tabular-nums text-ink-faint transition-colors hover:text-ink-dim"
      title={item.provider}
    >
      {parts.map((part, i) => (
        <span key={i}>{part}</span>
      ))}
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
    <div className="animate-rise space-y-1.5">
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

function NoticeLine({ item }: { item: NoticeItem }) {
  const tone = NOTICE_TONE[item.level ?? "info"] ?? "neutral";
  return (
    <div className="animate-rise flex justify-center">
      <div
        className={cn(
          "flex max-w-[80%] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
          tone === "rose" && "border-rose-dim/50 bg-rose-wash text-rose",
          tone === "copper" && "border-copper-dim/50 bg-copper-wash text-copper",
          tone === "neutral" && "border-line bg-raised text-ink-dim",
        )}
      >
        {item.source && (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">{item.source}</span>
        )}
        <span className="min-w-0 break-words" data-selectable>
          {item.text}
        </span>
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

/* ------------------------------------------------------------------ view */

export function TranscriptView({ items }: { items: RenderItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  // Last observed scrollTop, for scroll direction.
  const lastScrollTopRef = useRef(0);

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

  return (
    <div className="relative min-h-0 flex-1 bg-surface">
      <div
        ref={scrollRef}
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
        className="h-full overflow-y-auto px-4 py-4 [overflow-anchor:none]"
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
              {run.rows.map(({ item, count }, i) => (
                <ErrorBoundary key={item.id} fallback={(error) => <BrokenRow error={error} />}>
                  {((): ReactNode => {
                    switch (item.kind) {
                      case "user":
                        return <UserBubble item={item} first={i === 0} />;
                      case "assistant":
                        return <AssistantBlock item={item} />;
                      case "tool":
                        return <ToolCard item={item} />;
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
                    }
                  })()}
                </ErrorBoundary>
              ))}
            </div>
          ))}
        </div>
      </div>

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
    </div>
  );
}
