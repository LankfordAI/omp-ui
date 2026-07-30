import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import type {
  AssistantItem,
  IrcItem,
  MarkerItem,
  NoticeItem,
  RenderItem,
  UserItem,
} from "../lib/transcript";
import { Markdown } from "./Markdown";
import { AdvisoryNotes, ToolCard, formatDuration } from "./ToolCard";
import { Chip, Disclosure, Empty, Label, type Tone } from "./ui";

/** How close to the end still counts as "following the stream". */
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
      className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.5] text-ink-dim"
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

/* ------------------------------------------------------------------ view */

export function TranscriptView({ items }: { items: RenderItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const runs = useMemo(() => buildRuns(items), [items]);

  // Length alone misses streaming, which mutates the last item in place.
  const last = items.at(-1);
  const tailLength =
    last?.kind === "assistant"
      ? last.text.length + last.thinking.length
      : last?.kind === "tool"
        ? (last.partialText?.length ?? 0) + (last.resultText?.length ?? 0)
        : 0;

  useEffect(() => {
    // Reading up the transcript must not be interrupted by new output.
    if (!atBottom) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, tailLength, atBottom]);

  return (
    <div className="relative min-h-0 flex-1 bg-surface">
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK);
        }}
        className="h-full overflow-y-auto px-4 py-4"
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {items.length === 0 && (
            <Empty title="Nothing yet" hint="Send a prompt to start the session." />
          )}

          {runs.map((run) => (
            <div
              key={run.key}
              className={cn("flex flex-col", run.speaker === "meta" ? "gap-1" : "gap-1.5")}
            >
              {run.rows.map(({ item, count }, i) => {
                switch (item.kind) {
                  case "user":
                    return <UserBubble key={item.id} item={item} first={i === 0} />;
                  case "assistant":
                    return <AssistantBlock key={item.id} item={item} />;
                  case "tool":
                    return <ToolCard key={item.id} item={item} />;
                  case "advisory":
                    return (
                      <div key={item.id} className="animate-rise">
                        <AdvisoryNotes notes={item.notes} />
                      </div>
                    );
                  case "notice":
                    return <NoticeLine key={item.id} item={item} />;
                  case "irc":
                    return <IrcLine key={item.id} item={item} />;
                  case "marker":
                    return <MarkerRule key={item.id} item={item} count={count} />;
                }
              })}
            </div>
          ))}

          <div ref={endRef} />
        </div>
      </div>

      {!atBottom && items.length > 0 && (
        <button
          type="button"
          onClick={() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
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
