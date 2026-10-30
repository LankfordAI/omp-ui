import {
  Fragment,
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
import { summarizeExchanges, type ExchangeChanges } from "../lib/exchange-changes";
import { formatCost, tokenCount } from "../lib/format";
import { splitInterviewDraft } from "../lib/interview-draft";
import { localeTag, useT } from "../lib/i18n";
import { supportsNarration } from "../lib/narration";
import { isReplyWrite, replyWriteContent, supportsOutReplies } from "@omp-ui/core/out-replies";
import { useTranscriptScale } from "../lib/text-scale";
import type {
  AssistantItem,
  CommandItem,
  FleetWakeItem,
  IrcItem,
  MarkerItem,
  NoticeItem,
  RenderItem,
  ShellItem,
  ToolItem,
  UserItem,
} from "../lib/transcript";
import { onTranscriptReveal } from "../lib/transcript-reveal";
import {
  LOAD_OLDER_TRIGGER_PX,
  TRANSCRIPT_REVEAL_CONTEXT,
  TRANSCRIPT_WINDOW_STEP,
  windowStart,
} from "../lib/transcript-window";
import { findOwner, findRecord, sessionCwd, useStore } from "../store";
import { openChangesViewer } from "./ChangesViewer";
import { ErrorBoundary } from "./ErrorBoundary";
import { Markdown, linkify, OpenExternalLink } from "./Markdown";
import { openImageViewer } from "./ImageViewer";
import { PlanCard } from "./PlanCard";
import { AdvisoryNotes, ToolCard } from "./ToolCard";
import { VaultToolCard } from "./VaultToolCard";
import { VAULT_WRITE_TOOLS } from "@omp-ui/core/vault-shared";
import { SelectionContextMenu } from "./SelectionContextMenu";
import {
  SelectionCommentButton,
  SelectionCommentPopover,
  selectionInside,
  useSelectionCommentButton,
  type SelectionAnchor,
} from "./SelectionComment";
import { AnnotationChips } from "./AnnotationChips";
import { normalizeAnnotationQuote } from "../lib/annotations";
import { HeldPromptCard } from "./HeldPromptCard";
import { ScheduledPromptCard } from "./ScheduledPromptCard";
import {
  Chip,
  CopyButton,
  Disclosure,
  Empty,
  IconPencil,
  IconRewind,
  Label,
  type Tone,
} from "./ui";

/** Re-entry threshold: this close to the tail still counts as following. */
const AT_BOTTOM_SLACK = 64;

/* ------------------------------------------------------------- assistant */

/**
 * The receipt: one dim line under a finished turn. It exists so cost and
 * latency are always answerable without opening a panel, which means it has
 * to stay quiet enough to ignore — hence one line, faint until hover.
 */
function UsageStrip({ item }: { item: AssistantItem }) {
  const t = useT();
  const usage = item.usage;
  if (!usage) return null;
  const parts: string[] = [];
  // item.model is the requested selector, not an inferred routed model.
  if (item.model) parts.push(item.model);
  if (item.upstreamProvider) parts.push(t("transcript.usage.via", { provider: item.upstreamProvider }));
  parts.push(`↑${tokenCount(usage.input)}`, `↓${tokenCount(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`${t("transcript.usage.cache")} ${tokenCount(usage.cacheRead)}`);
  if (usage.cost > 0) parts.push(formatCost(usage.cost));
  if (item.ttftMs !== undefined && item.ttftMs > 0)
    parts.push(`${t("transcript.usage.ttft")} ${formatDuration(item.ttftMs)}`);
  if (item.durationMs !== undefined && item.durationMs > 0) parts.push(formatDuration(item.durationMs));
  // Decode rate: generated tokens over the post-ttft window only. Unlike omp
  // stats' tokens/s this excludes time to first token, and it renders only
  // when both halves of the subtraction exist — no ttft means no honest rate.
  if (
    usage.output > 0 &&
    item.durationMs !== undefined && item.ttftMs !== undefined &&
    item.durationMs > item.ttftMs && item.ttftMs > 0
  ) {
    const rate = (usage.output * 1000) / (item.durationMs - item.ttftMs);
    parts.push(`${rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1)} ${t("transcript.usage.rate")}`);
  }
  if (item.stopReason && item.stopReason !== "end_turn" && item.stopReason !== "stop") {
    parts.push(item.stopReason);
  }
  // Wall-clock anchor: local short time inline, full locale date+time on hover.
  const at = item.timestamp === undefined ? null : new Date(item.timestamp);
  const atText = at?.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const atTooltip = at?.toLocaleString(localeTag());
  // Hover facts, in order: gateway, upstream, response id, completion time.
  const facts = [
    item.provider ? t("transcript.usage.gateway", { provider: item.provider }) : null,
    item.upstreamProvider ? t("transcript.usage.upstream", { provider: item.upstreamProvider }) : null,
    item.responseId ? t("transcript.usage.response", { id: item.responseId }) : null,
    atTooltip,
  ];
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] tabular-nums text-ink-faint transition-colors hover:text-ink-dim"
      title={facts.filter(Boolean).join(" · ") || undefined}
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

/**
 * The exchange receipt (issue #933): one faint line under a settled exchange
 * totting up every diff card it produced — UsageStrip's restraint applied to
 * file churn. Clicking opens the whole set in the ChangesViewer, so the quiet
 * count row is also the fast path back into the diffs.
 */
const ExchangeReceipt = memo(function ExchangeReceipt({
  changes,
  tabId,
}: {
  changes: ExchangeChanges;
  /** Forwarded so the viewer's footer can jump the rail to Diffs. */
  tabId?: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() =>
        openChangesViewer({
          cards: changes.entries.map((entry) => ({
            key: entry.itemId,
            path: entry.path,
            op: entry.op,
            rows: entry.rows,
          })),
          tabId,
        })
      }
      className="flex flex-wrap items-center gap-x-2 font-mono text-[10px] tabular-nums text-ink-faint transition-colors hover:text-ink-dim"
    >
      <span>{t("transcript.receipt.changedFiles", { files: changes.files })}</span>
      <span className="text-signal">+{changes.added}</span>
      <span className="text-rose">−{changes.removed}</span>
      <span>{t("transcript.receipt.openDiff")}</span>
    </button>
  );
});

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

function AssistantBlock({ item, tabId }: { item: AssistantItem; tabId?: string }) {
  const t = useT();
  // omp 18.12+ tags between-tool narration (issue #884): it reads as reply
  // prose and leaves the thinking pane. On older or unknown harnesses the
  // flag may exist on a binary that never meant it, so it stays folded in.
  const gated = useStore((s) =>
    tabId !== undefined && supportsNarration(s.rpc[tabId]?.capabilities?.ompVersion ?? null),
  );
  const shownThinking = gated
    ? item.thinking
    : [item.thinking, item.narration].filter(Boolean).join("\n");
  // Reasoning is the only visible progress before the first token of prose.
  const working = item.streaming && item.text === "";
  const caret = item.streaming ? (
    <span className="animate-caret ml-px inline-block align-baseline font-mono text-signal">▍</span>
  ) : undefined;
  const markdownSource = [gated ? item.narration : "", item.text].filter(Boolean).join("\n\n");

  return (
    // `data-markdown-source` carries the turn's raw markdown so the selection
    // context menu can offer "Copy as Markdown" (issue #72). The attribute marks
    // a node whose displayed text is its own markdown source — assistant prose
    // and user prompts both qualify; tool cards, code blocks, and thinking
    // deliberately do not.
    <div
      className="animate-rise space-y-1.5"
      data-markdown-source={markdownSource !== "" ? markdownSource : undefined}
    >
      {shownThinking !== "" && (
        <Disclosure
          // Remount on the working→answering flip so the pane auto-opens while
          // there is nothing else to watch, then folds once prose arrives —
          // without ever fighting a user who opened it by hand.
          key={working ? "live" : "idle"}
          defaultOpen={working}
          className="rounded-md border border-line-soft bg-sunken px-2 py-1"
          summary={<Label className="text-copper">{t("transcript.assistant.thinking")}</Label>}
        >
          <ThinkingPane text={shownThinking} live={working} />
        </Disclosure>
      )}
      {gated && item.narration !== "" && (
        <Markdown text={item.narration} className="text-ink" />
      )}
      {(item.text !== "" || caret) && (
        <Markdown text={item.text} className="text-ink" trailing={caret} />
      )}
      <UsageStrip item={item} />
    </div>
  );
}

/**
 * A `write` to `out://` (omp 18.14, issue #969): the agent's mid-turn reply,
 * streamed from the call's args and presented as assistant prose, not a tool
 * card. A refused write keeps the prose and states omp's reason under it.
 */
function ReplyWriteBlock({ item }: { item: ToolItem }) {
  const text = replyWriteContent(item.args);
  const caret =
    item.status === "running" ? (
      <span className="animate-caret ml-px inline-block align-baseline font-mono text-signal">▍</span>
    ) : undefined;
  return (
    <div className="animate-rise space-y-1" data-markdown-source={text !== "" ? text : undefined}>
      {(text !== "" || caret) && <Markdown text={text} className="text-ink" trailing={caret} />}
      {item.status === "error" && item.resultText && (
        <p data-selectable className="font-mono text-[11px] leading-snug text-rose">
          {item.resultText}
        </p>
      )}
    </div>
  );
}

/** Each `> out://` write a bash run made (details.replies, issue #969), as prose after its card. */
function ToolReplies({ replies }: { replies: readonly string[] }) {
  return (
    <>
      {replies.map((reply, i) => (
        <div key={i} className="animate-rise" data-markdown-source={reply}>
          <Markdown text={reply} className="text-ink" />
        </div>
      ))}
    </>
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
 * The message's raw markdown when the selection starts inside prose that
 * carries `data-markdown-source` — assistant turns and user prompts. Tool
 * cards, code blocks, and thinking yield null, so "Copy as Markdown" hides
 * there; that is the issue's "where the selection maps cleanly onto a render
 * item's source".
 */
function markdownSourceForSelection(sel: Selection): string | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const node = sel.getRangeAt(0).startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return el?.closest("[data-markdown-source]")?.getAttribute("data-markdown-source") ?? null;
}

/* ------------------------------------------------------------ small kinds */

function UserBubble({
  item,
  first,
  tabId,
  position,
}: {
  item: UserItem;
  first: boolean;
  /** The owning tab; the rewind affordances exist only on a live native tab. */
  tabId?: string;
  /** Index among the tab's user items; the rewind correlation's positional key. */
  position?: number;
}) {
  const t = useT();
  const stageRewind = useStore((s) => s.stageRewind);
  // The affordances exist only on a live native tab (issue #680): a PTY tab
  // has no entry tree to correlate against, and a dormant one no process to
  // branch. The NoticeLine pattern — one narrow store read per row.
  const rewindable = useStore(
    (s) =>
      tabId !== undefined &&
      position !== undefined &&
      findRecord(s.state, tabId)?.live === "live" &&
      findRecord(s.state, tabId)?.mode === "rpc-ui",
  );
  // Streaming is refused, not queued — `branch` switches the live process
  // in place (the action re-checks the same rule).
  const rewindBusy = useStore(
    (s) =>
      tabId !== undefined &&
      (s.rpc[tabId]?.status === "running" || s.rpc[tabId]?.busy === true),
  );
  // Display-only: a synthetic interview kickoff renders its draft as a
  // captioned data block. item.text stays canonical for copy/find/rewind.
  const draft = useMemo(() => splitInterviewDraft(item.text), [item.text]);
  const images = item.images ?? [];
  const viewerImages = useMemo(
    () =>
      (item.images ?? []).map((im, n) => ({
        src: `data:${im.mimeType};base64,${im.data}`,
        mimeType: im.mimeType,
        label: t("transcript.image.alt", { n: n + 1 }),
      })),
    [item.images, t],
  );
  const rewindTitle = rewindBusy ? t("transcript.rewind.busy") : undefined;
  const fileMentions = item.fileMentions ?? [];
  const documents = item.documents ?? [];
  const annotations = item.annotations ?? [];
  return (
    <div className="speaker-run animate-rise flex flex-col items-end gap-1">
      {first && <Label className="speaker-label speaker-label-right">{t("transcript.speaker.you")}</Label>}
      <div
        className="group relative min-w-0 max-w-[72%] space-y-2 rounded-lg border border-iris-dim/40 bg-iris-wash px-3 py-2 text-ink has-[.md-plan]:w-full has-[.md-plan]:max-w-full"
        data-markdown-source={item.text !== "" ? item.text : undefined}
      >
        {annotations.length > 0 && <AnnotationChips annotations={annotations} align="end" />}
        {draft === null ? (
          item.text !== "" && <Markdown text={item.text} />
        ) : (
          <>
            <Markdown text={draft.preamble} />
            <div className="space-y-1">
              <Label className="speaker-label speaker-label-right">
                {t(draft.captionKey)}
              </Label>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded border border-line-strong bg-sunken px-2 py-1.5 font-mono text-[0.9em]">
                {draft.draft}
              </pre>
            </div>
          </>
        )}
        {fileMentions.length > 0 && (
          <div
            role="group"
            aria-label={t("transcript.mentions.label")}
            className="flex max-w-full flex-wrap justify-end gap-1.5"
          >
            {fileMentions.map((path) => (
              <Chip key={path} tone="iris" mono truncate title={path}>
                @{path}
              </Chip>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((image, i) => (
              <button
                // Index-keyed deliberately: a message's image list is fixed
                // once rendered, and the base64 payload is far too long a key.
                key={i}
                type="button"
                className="block cursor-zoom-in rounded border-0 p-0"
                title={t("transcript.image.title", {
                  mimeType: image.mimeType,
                  n: i + 1,
                  count: images.length,
                })}
                aria-label={t("image.viewer.open", { n: i + 1 })}
                onClick={() => openImageViewer(viewerImages, i)}
              >
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={t("transcript.image.alt", { n: i + 1 })}
                  className="max-h-40 rounded border border-line-strong bg-sunken object-contain"
                />
              </button>
            ))}
          </div>
        )}
        {documents.length > 0 && (
          <div
            role="group"
            aria-label={t("transcript.document.label")}
            className="flex max-w-full flex-wrap justify-end gap-1.5"
          >
            {documents.map((document, i) => (
              <Chip
                // Path alone can repeat when the same file is attached twice.
                key={`${document.path}#${i}`}
                tone="iris"
                mono
                truncate
                title={t("transcript.document.alt", { name: document.name, path: document.path })}
              >
                {document.name}
              </Chip>
            ))}
          </div>
        )}
        {(item.text !== "" || rewindable) && (
          // Absolutely positioned so hovering never changes the bubble's height:
          // follow mode re-pins on content size, and a reserved footer row would
          // jitter it. Keyboard-reachable while invisible, so Tab into the bubble
          // reveals the chip the same way hover does.
          <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-md border border-line bg-overlay/85 px-1 py-0.5 opacity-0 backdrop-glass transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            {item.text !== "" && (
              <CopyButton
                text={item.text}
                label={t("common.button.copy")}
                doneLabel={t("common.button.copied")}
              />
            )}
            {rewindable && tabId !== undefined && (
              <>
                <button
                  type="button"
                  className="grid size-6 shrink-0 place-items-center rounded-md text-ink-dim transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-default disabled:text-ink-faint"
                  aria-label={t("transcript.rewind.here")}
                  title={rewindTitle}
                  disabled={rewindBusy}
                  onClick={() => void stageRewind(tabId, position ?? 0, false)}
                >
                  <IconRewind />
                </button>
                <button
                  type="button"
                  className="grid size-6 shrink-0 place-items-center rounded-md text-ink-dim transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-default disabled:text-ink-faint"
                  aria-label={t("transcript.rewind.edit")}
                  title={rewindTitle}
                  disabled={rewindBusy}
                  onClick={() => void stageRewind(tabId, position ?? 0, true)}
                >
                  <IconPencil />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const NOTICE_TONE: Record<string, Tone> = { error: "rose", warn: "copper", info: "neutral" };

function NoticeLine({ item, tabId }: { item: NoticeItem; tabId?: string }) {
  const t = useT();
  const reportError = useStore((s) => s.reportError);
  const openCapabilitiesViewer = useStore((s) => s.openCapabilitiesViewer);
  const openSettings = useStore((s) => s.openSettings);
  // A path on a remote instance's disk (issue #416) cannot be opened here:
  // `file:open` is host-local, so the notice reads as plain text there.
  const remote = useStore((s) => tabId !== undefined && findOwner(s.state, tabId)?.instanceId != null);
  const tone = NOTICE_TONE[item.level ?? "info"] ?? "neutral";
  // A notice carrying a path (the exported transcript HTML, issue #84) is a
  // link: the text opens the file with the system handler, the folder glyph
  // reveals it in the file manager.
  const path = remote ? undefined : item.path;
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
        {item.mcpMount !== undefined ? (
          // The collapsed xdev mount notice (issue #848): the tool-name wall
          // is one count here; the full roster is the Tools tab of the
          // CapabilitiesViewer, one click away.
          <button
            type="button"
            className="cursor-pointer text-left underline decoration-dotted underline-offset-2 hover:text-ink"
            data-selectable
            // Pin the viewer to the session's own working tree (the /mcp
            // list pattern, session-params.ts): a null scope with a tabId
            // would read as drift-detached and hide the roster.
            onClick={() => {
              const s = useStore.getState();
              const tab = tabId === undefined ? undefined : s.tabs.find((c) => c.tabId === tabId);
              const scopeCwd =
                (tabId !== undefined ? sessionCwd(findRecord(s.state, tabId)) : undefined) ??
                tab?.projectCwd;
              openCapabilitiesViewer(scopeCwd ?? null, tabId, "tools", tab?.instanceId ?? null);
            }}
          >
            {t(
              item.mcpMount.count === 1 ? "notice.mcpMount.one" : "notice.mcpMount",
              { count: item.mcpMount.count },
            )}{" "}
            <span className="text-ink-dim">{t("notice.mcpMount.view")}</span>
          </button>
        ) : path === undefined ? (
          <>
            <span className="min-w-0 break-words" data-selectable>
              {item.text}
            </span>
            {/* The spend-cap stop (issue #952): Settings → omp edits this
                machine's config, so a remote tab gets the text only. */}
            {item.costCap === true && !remote && (
              <button
                type="button"
                className="shrink-0 cursor-pointer underline decoration-dotted underline-offset-2 hover:text-ink"
                onClick={() => openSettings("omp")}
              >
                {t("notice.costCap.raise")}
              </button>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              title={t("notice.path.open", { path })}
              className="min-w-0 cursor-pointer break-words text-left underline decoration-dotted underline-offset-2 hover:text-ink"
              data-selectable
              onClick={() => void backend.openPath(path).catch(reportError)}
            >
              {item.text}
            </button>
            <button
              type="button"
              title={t("notice.path.reveal")}
              aria-label={t("notice.path.reveal")}
              className="shrink-0 cursor-pointer text-ink-faint hover:text-ink"
              onClick={() => void backend.showPathInFolder(path).catch(reportError)}
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

function FleetWakeCard({ item }: { item: FleetWakeItem }) {
  const t = useT();
  const question = item.card.kind === "question";
  return (
    <div className="animate-rise rounded-md border border-line bg-raised px-2.5 py-1.5">
      <div className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
        <Chip tone={question ? "copper" : "signal"}>
          {t(question ? "transcript.fleetWake.question" : "transcript.fleetWake.result")}
        </Chip>
        <span className="min-w-0 truncate text-ink-mid">
          {t("transcript.fleetWake.from", { title: item.card.title, machine: item.card.machine })}
        </span>
      </div>
      <Markdown text={item.text} className="mt-1 text-[12px]" />
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
  const t = useT();
  const startTuiHandoff = useStore((s) => s.startTuiHandoff);
  if (tabId === undefined || item.output === undefined || !TUI_ONLY_REPLY.test(item.output))
    return null;
  return (
    <button
      type="button"
      className="mt-1.5 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-mid hover:text-ink"
      onClick={() => startTuiHandoff(tabId, commandLine(item))}
    >
      {t("transcript.command.tuiHandoff")}
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
          {linkify(item.output)}
        </pre>
      )}
      <ShareLinkRow item={item} />
      <TuiHandoffButton item={item} tabId={tabId} />
    </div>
  );
}

/**
 * Open + copy affordance for omp's `/share` reply (issue #679). The row's
 * own `<pre>` already shows every output line verbatim — with the bare URL
 * autolinked — so this only adds the explicit affordances; it appears on a
 * command row whose output carries the share line, mirroring how
 * `TuiHandoffButton` sniffs output text.
 */
// omp's headless /share answers "Share URL: <https url with #key>" on the
// command's output (issue #679). Match the whole URL, scheme-gated so a
// malformed line stays inert text.
const SHARE_URL = /^Share URL: (https?:\/\/\S+)$/m;

export function ShareLinkRow({ item }: { item: CommandItem }) {
  const t = useT();
  const url = item.output === undefined ? null : item.output.match(SHARE_URL)?.[1];
  if (url === undefined || url === null) return null;
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <OpenExternalLink href={url}>{t("transcript.command.shareOpen")}</OpenExternalLink>
      <CopyButton text={url} label={t("common.button.copy")} doneLabel={t("common.button.copied")} />
    </div>
  );
}

/**
 * One "!" shell command: the line as typed, a running caret with a stop
 * control while omp's bash response is outstanding, then the settled output,
 * exit code, or failure (issue #678). Styling follows CommandRow.
 */
function ShellRow({ item, tabId }: { item: ShellItem; tabId?: string }) {
  const t = useT();
  const abortShellCommands = useStore((s) => s.abortShellCommands);
  return (
    <div className="animate-rise rounded border border-line-soft bg-sunken px-2 py-1.5 font-mono text-[12px] leading-[1.55]">
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-ink-faint">$</span>
        <span
          data-selectable
          className={cn(
            "min-w-0 break-words",
            item.status === "failed" ? "text-rose" : "text-ink",
          )}
        >
          {item.command}
        </span>
        {item.status === "running" && tabId !== undefined && (
          <>
            <span className="animate-caret inline-block shrink-0 align-baseline text-signal">▍</span>
            <button
              type="button"
              className="ml-auto shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-mid hover:text-ink"
              onClick={() => void abortShellCommands(tabId)}
            >
              {t("transcript.shell.stop")}
            </button>
          </>
        )}
        {item.status === "done" && item.exitCode !== undefined && item.exitCode !== 0 && (
          <span className="ml-auto shrink-0 text-rose">exit {item.exitCode}</span>
        )}
        {item.status === "done" && (item.exitCode === undefined || item.exitCode === 0) && (
          <span className="ml-auto shrink-0 text-ink-faint">✓</span>
        )}
        {item.status === "cancelled" && (
          <span className="ml-auto shrink-0 text-ink-faint">{t("transcript.shell.cancelled")}</span>
        )}
      </div>
      {item.status === "failed" && item.error !== undefined && (
        <p
          data-selectable
          className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug text-rose"
        >
          {item.error}
        </p>
      )}
      {item.truncated === true && (
        <p className="mt-1 text-[11px] text-ink-faint">{t("transcript.shell.truncated")}</p>
      )}
      {item.shared === false && (
        <p className="mt-1 text-[11px] text-ink-faint">{t("transcript.shell.notShared")}</p>
      )}
      {item.output !== undefined && item.output !== "" && (
        <pre
          data-selectable
          className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-ink-mid"
        >
          {item.output}
        </pre>
      )}
    </div>
  );
}

/**
 * What a transcript row that threw during render collapses to. The message
 * itself is unrecoverable (same props → same throw), so this shows just enough
 * to report: the row died, and why.
 */
function BrokenRow({ error }: { error: Error }) {
  const t = useT();
  return (
    <div className="rounded-md border-l-[3px] border-rose-dim bg-rose-wash px-2.5 py-1.5">
      <Label className="text-rose">{t("transcript.row.broken")}</Label>
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
  shell: "shell",
  fleetWake: "meta",
};

/** A reply write reads as the assistant speaking, so it joins the assistant's run. */
function isPresentedReplyWrite(item: RenderItem, replyWrites: boolean): boolean {
  return replyWrites && item.kind === "tool" && isReplyWrite(item.name, item.args) === true;
}

function buildRuns(items: RenderItem[], replyWrites: boolean): Run[] {
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
    const speaker = isPresentedReplyWrite(item, replyWrites) ? "assistant" : SPEAKER[item.kind];
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
  userPosition,
  replyWrites,
}: {
  item: RenderItem;
  count: number;
  first: boolean;
  tabId?: string;
  /** Index among the transcript's user items (issue #680). A plain number:
   *  stable per item, so the row stays shallow-compare stable (#187). */
  userPosition?: number;
  /** The tab's omp presents `write` to `out://` as a reply (issue #969). */
  replyWrites: boolean;
}) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} first={first} tabId={tabId} position={userPosition} />;
    case "assistant":
      return <AssistantBlock item={item} tabId={tabId} />;
    case "tool":
      if (isPresentedReplyWrite(item, replyWrites)) return <ReplyWriteBlock item={item} />;
      return (
        <>
          {/* The four vault write tools get their own card (issue #767); reads, search and list stay generic. */}
          {VAULT_WRITE_TOOLS.some((name) => name === item.name) ? (
            <VaultToolCard item={item} tabId={tabId} />
          ) : (
            <ToolCard item={item} tabId={tabId} />
          )}
          {item.replies !== undefined && <ToolReplies replies={item.replies} />}
        </>
      );
    case "advisory":
      return (
        <div className="animate-rise">
          <AdvisoryNotes notes={item.notes} />
        </div>
      );
    case "notice":
      return <NoticeLine item={item} tabId={tabId} />;
    case "irc":
      return <IrcLine item={item} />;
    case "marker":
      return <MarkerRule item={item} count={count} />;
    case "plan":
      return <PlanCard item={item} />;
    case "command":
      return <CommandRow item={item} tabId={tabId} />;
    case "shell":
      return <ShellRow item={item} tabId={tabId} />;
    case "fleetWake":
      return <FleetWakeCard item={item} />;
  }
});

/* ------------------------------------------------------------------ view */

export interface FindState {
  ids: string[]; // matched item ids, transcript order
  activeId: string; // the match to centre on
  nonce: number; // jump counter: changing it re-runs the scroll
}

/**
 * Minimum side slack, in visual px, for speaker labels to hang in the
 * gutters (issue #392). Widest label ("assistant"/"어시스턴트" at 10px with
 * 0.14em tracking) is ~90px, plus the 1rem label margin and the scroll pane's
 * 1rem padding.
 */
const HANGING_GUTTER_PX = 128;

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
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** The tail spacer that reserves the floating composer's height. */
  const insetRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  // Bounded tail window (issue #867, ADR-0057): `frozenStart` null means
  // follow mode — the window is the newest TRANSCRIPT_WINDOW_ROWS items and
  // appends drop the oldest rendered rows. Reading freezes the start so
  // content never shifts under the reader; "load older" moves it back only.
  const [frozenStart, setFrozenStart] = useState<number | null>(null);
  const start = windowStart(items.length, frozenStart);
  const startRef = useRef(start);
  startRef.current = start;
  const visible = useMemo(() => (start === 0 ? items : items.slice(start)), [items, start]);
  /** Distance from the bottom captured by loadOlder, restored after its commit. */
  const olderAnchorRef = useRef<number | null>(null);
  const [reveal, setReveal] = useState<{ id: string; seq: number } | null>(null);
  const revealSeqRef = useRef(0);
  const handledRevealRef = useRef(0);
  // Whether the centred column leaves enough side slack for speaker labels
  // to hang in the gutters (issue #392). The ref guards renders on resize.
  const [hanging, setHanging] = useState(false);
  const hangingRef = useRef(false);
  // Last observed scrollTop, for scroll direction.
  const lastScrollTopRef = useRef(0);
  const [menu, setMenu] = useState<TranscriptMenuState | null>(null);
  // Comment… (issue #983): an annotation goes to this tab's composer, so only
  // a live native tab offers it — never a subagent view or a PTY tab.
  const canComment = useStore(
    (s) =>
      tabId !== undefined &&
      findRecord(s.state, tabId)?.mode === "rpc-ui" &&
      findRecord(s.state, tabId)?.live === "live",
  );
  const queueComposerAnnotations = useStore((s) => s.queueComposerAnnotations);
  /** The selection the comment popover annotates; null while closed. */
  const [comment, setComment] = useState<SelectionAnchor | null>(null);
  const commentButton = useSelectionCommentButton(
    scrollRef,
    canComment && menu === null && comment === null,
  );

  function updateFollowing(value: boolean) {
    followingRef.current = value;
    setFollowing(value);
    if (value) setFrozenStart(null);
    else setFrozenStart((current) => current ?? startRef.current);
  }

  /** Widens the window by one step above the oldest rendered row, holding the
   *  viewport still through `olderAnchorRef` (issue #867). */
  function loadOlder() {
    const el = scrollRef.current;
    if (!el || startRef.current === 0 || olderAnchorRef.current !== null) return;
    olderAnchorRef.current = el.scrollHeight - el.scrollTop;
    updateFollowing(false);
    // React applies the queued updaters in order, so this plain value wins
    // over the freeze updater just queued by updateFollowing(false).
    setFrozenStart(Math.max(0, startRef.current - TRANSCRIPT_WINDOW_STEP));
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

  // omp 18.14+ (issue #969): a `write` to `out://` is a mid-turn reply. On an
  // older or unknown harness the path is just a path, so the card stays.
  const replyWrites = useStore(
    (s) => tabId !== undefined && supportsOutReplies(s.rpc[tabId]?.capabilities?.ompVersion ?? null),
  );
  // Runs are built from the bounded tail window only (issue #867); the DOM
  // cost is the window's, never the tab's whole history.
  const runs = useMemo(() => buildRuns(visible, replyWrites), [visible, replyWrites]);
  // The rewind correlation's positional key (issue #680): each user item's
  // index among user items. The map is rebuilt with the items, but the value
  // handed to each row is a stable primitive, so a stream tick leaves every
  // historical row's props shallow-equal (#187).
  const userPositions = useMemo(() => {
    const positions = new Map<string, number>();
    let n = 0;
    for (const item of items) if (item.kind === "user") positions.set(item.id, n++);
    return positions;
  }, [items]);

  // Exchange receipts (issue #933): the rollups come off the full item list,
  // never the window slice — a receipt must not lose its oldest card when
  // that card scrolls out of the tail window. `byUserId` re-derives the same
  // anchor rule summarizeExchanges keys by (ambient rows skipped) so a run
  // can find its rollup at a user boundary; the walk's ending anchor is the
  // trailing exchange's key.
  const exchangeChanges = useMemo(() => summarizeExchanges(items), [items]);
  const exchangeAnchors = useMemo(() => {
    const byUserId = new Map<string, string>();
    let anchor: string | null = null;
    for (const item of items) {
      if (item.kind === "user") {
        if (anchor !== null) byUserId.set(item.id, anchor);
        anchor = null;
      } else if (item.kind !== "marker" && item.kind !== "notice" && item.kind !== "irc") {
        anchor = item.id;
      }
    }
    return { byUserId, tailAnchor: anchor };
  }, [items]);
  // Streaming is refused, not queued — same narrow read as the rewind guard.
  const turnActive = useStore(
    (s) =>
      tabId !== undefined &&
      (s.rpc[tabId]?.status === "running" || s.rpc[tabId]?.busy === true),
  );
  // The trailing receipt only earns its line once the tab is idle; a live
  // subagent view (no tabId) shows none.
  const trailingReceipt =
    tabId === undefined || turnActive || exchangeAnchors.tailAnchor === null
      ? undefined
      : exchangeChanges.get(exchangeAnchors.tailAnchor);
  const scale = useTranscriptScale();

  // Length alone misses streaming, which mutates the last item in place.
  const last = items.at(-1);
  const tailLength =
    last?.kind === "assistant"
      ? last.text.length + last.thinking.length + last.narration.length
      : last?.kind === "tool"
        ? (last.partialText?.length ?? 0) +
          (last.resultText?.length ?? 0) +
          (last.argsText?.length ?? 0) +
          (last.replies?.length ?? 0)
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

  // Load older keeps the viewport still: the rows added above push content
  // down by exactly the growth, so restore the captured distance from the
  // bottom. Writing `lastScrollTopRef` makes the scroll echo read as “not
  // upward”, so the restore never triggers another load or a follow change.
  useLayoutEffect(() => {
    const saved = olderAnchorRef.current;
    const el = scrollRef.current;
    if (saved === null || !el) return;
    olderAnchorRef.current = null;
    el.scrollTop = el.scrollHeight - saved;
    lastScrollTopRef.current = el.scrollTop;
  }, [start]);

  // Re-pin on layout changes that bypass `items`: tool-card expansion,
  // markdown/image re-layout, window resize. When not following the callback
  // does nothing, so the viewport stays put exactly as before.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let lastElWidth = -1;
    let lastContentWidth = -1;
    const measureHanging = () => {
      // Gutter slack (issue #392). getBoundingClientRect on both: under the
      // content's `zoom` it reports visual px for either element, offsetWidth
      // does not. The observer fires on every content-height change — every
      // streaming flush — but slack only moves with widths, so unchanged
      // widths skip both forced-layout reads (#858).
      const elWidth = el.getBoundingClientRect().width;
      const contentWidth = content.getBoundingClientRect().width;
      if (elWidth === lastElWidth && contentWidth === lastContentWidth) return;
      lastElWidth = elWidth;
      lastContentWidth = contentWidth;
      const slack = (elWidth - contentWidth) / 2;
      const next = slack >= HANGING_GUTTER_PX;
      if (next !== hangingRef.current) {
        hangingRef.current = next;
        setHanging(next);
      }
    };
    const observer = new ResizeObserver(() => {
      if (followingRef.current) pinToBottom();
      measureHanging();
    });
    // Measure once synchronously so the first paint already hangs or stacks.
    measureHanging();
    observer.observe(el); // clientHeight and width changes: window resize, zoom
    observer.observe(content); // content height changes: cards, images, markdown
    // The tail spacer's height is the floating composer's (issue #395): a
    // growing draft must re-pin, or follow mode would leave the newest row
    // parked behind the card. Neither `el` nor `content` changes box when the
    // spacer does, so the spacer is observed in its own right.
    if (insetRef.current !== null) observer.observe(insetRef.current);
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

  // In-session find (issue #270): a nonce bump is the only trigger; it now
  // posts a reveal request instead of touching the DOM directly, so the jump
  // can widen the tail window first (issue #867).
  const lastFindNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (find === null) return;
    if (lastFindNonceRef.current === find.nonce) return;
    lastFindNonceRef.current = find.nonce;
    setReveal({ id: find.activeId, seq: ++revealSeqRef.current });
  }, [find?.nonce]);

  // Reveal requests from outside the transcript (Vault notes, issue #767)
  // arrive on the bus for this tab; the subagent view has no tabId and so no
  // subscription, exactly as before.
  useEffect(() => {
    if (tabId === undefined) return;
    return onTranscriptReveal(tabId, (id) => setReveal({ id, seq: ++revealSeqRef.current }));
  }, [tabId]);

  // One reveal path: widen the window when the target is above it, then
  // centre the target. Follow-mode contract (issue #7) unchanged.
  useLayoutEffect(() => {
    if (reveal === null || handledRevealRef.current === reveal.seq) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const index = items.findIndex((item) => item.id === reveal.id);
    if (index !== -1 && index < start) {
      updateFollowing(false);
      setFrozenStart(Math.max(0, index - TRANSCRIPT_REVEAL_CONTEXT));
      return; // re-runs once `start` covers the target
    }
    handledRevealRef.current = reveal.seq;
    // A collapsed marker run renders only its first item: walk back to the
    // nearest rendered row, never above the window.
    const from = index === -1 ? items.length - 1 : index;
    let target: Element | null = null;
    for (let i = from; i >= start; i -= 1) {
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
    if (rows.length > 0 && rows[rows.length - 1] !== target) updateFollowing(false);
    target.scrollIntoView({ block: "center" });
  }, [reveal, start, items]);

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
          if (scrollRef.current === null || !selectionInside(scrollRef.current, sel)) return;
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
          // Reading near the top pages older items in (issue #867).
          if (!followingRef.current && el.scrollTop <= LOAD_OLDER_TRIGGER_PX) loadOlder();
        }}
        className="transcript-scroll h-full overflow-y-auto px-4 py-4 [overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          data-hanging={hanging}
          className="transcript-column mx-auto flex max-w-[var(--transcript-max)] flex-col gap-5"
          // Transcript-scoped text size (issue #30): `zoom` scales every px
          // value inside the document surface — markdown, tool cards, slabs —
          // while the chrome around it stays fixed. The ResizeObserver above
          // sees the resulting content-height change and re-pins.
          style={{ zoom: scale }}
        >
          {items.length === 0 && (
            <Empty title={t("transcript.empty.title")} hint={t("transcript.empty.hint")} />
          )}

          {/* Head pager for the tail window (issue #867): the keyboard and
              short-content path when the scroll trigger cannot fire. */}
          {start > 0 && (
            <button
              type="button"
              onClick={loadOlder}
              className="self-center rounded-full border border-line px-3 py-1 text-[11px] text-ink-mid transition-colors hover:text-ink"
            >
              {t("transcript.view.showEarlier", { count: start })}
            </button>
          )}

          {runs.map((run, runIndex) => {
            // The exchange-ending boundary (issue #933): a receipt rides the
            // last run before a user prompt, looked up by that exchange's
            // anchor — the ambient-skipped walk mirrors summarizeExchanges.
            const next = runs[runIndex + 1];
            const boundaryAnchor =
              next?.speaker === "user" ? exchangeAnchors.byUserId.get(next.key) : undefined;
            const receipt =
              boundaryAnchor === undefined ? undefined : exchangeChanges.get(boundaryAnchor);
            return (
              <Fragment key={run.key}>
                <div
                  className={cn("speaker-run flex flex-col", run.speaker === "meta" ? "gap-1" : "gap-1.5")}
                >
                  {/* The assistant's hanging speaker label, mirroring the user's
                      "you" (issue #32): with turn markers deliberately absent, this
                      is the quiet cue that a new exchange begins. Only the run
                      that opens the exchange gets it — assistant fragments after
                      a tool run are the same reply, and labeling each one would
                      rebuild the marker-noise problem the markers solved. */}
                  {run.speaker === "assistant" && opensExchange(runs, runIndex) && (
                    <Label className="speaker-label speaker-label-left">
                      {t("transcript.speaker.assistant")}
                    </Label>
                  )}
                  {run.rows.map(({ item, count }, i) => {
                    const findClass = findClassById?.get(item.id);
                    return (
                      <div key={item.id} data-item-id={item.id} className={findClass}>
                        <ErrorBoundary fallback={(error) => <BrokenRow error={error} />}>
                          <TranscriptRow
                            item={item}
                            count={count}
                            first={i === 0}
                            tabId={tabId}
                            userPosition={
                              item.kind === "user" ? userPositions.get(item.id) : undefined
                            }
                            replyWrites={replyWrites}
                          />
                        </ErrorBoundary>
                      </div>
                    );
                  })}
                </div>
                {receipt !== undefined && (
                  <div data-item-id={`${receipt.anchorId}:receipt`}>
                    <ExchangeReceipt changes={receipt} tabId={tabId} />
                  </div>
                )}
              </Fragment>
            );
          })}
          {/* The tail line for the trailing exchange (issue #933): held back
              until the turn settles, because its diffs are still arriving. */}
          {trailingReceipt !== undefined && (
            <div data-item-id={`${trailingReceipt.anchorId}:receipt`}>
              <ExchangeReceipt changes={trailingReceipt} tabId={tabId} />
            </div>
          )}
          {/* Send at reset (issue #986): the prompt the host holds goes last. */}
          {tabId !== undefined && <HeldPromptCard tabId={tabId} />}
          {/* Scheduled prompt (issue #987): the session's schedule and its notices. */}
          {tabId !== undefined && <ScheduledPromptCard tabId={tabId} />}
        </div>
        {/* Tail clearance for the floating composer (issue #395). RpcTab
            publishes its measured height; every other host of this view — the
            subagent view — leaves the property unset, so the fallback keeps
            the old geometry exactly. Outside .transcript-column on purpose:
            the reserve is chrome pixels, and `zoom` must not scale it. */}
        <div
          ref={insetRef}
          aria-hidden
          className="h-[var(--transcript-bottom-inset,0px)]"
        />
      </div>
      {!following && items.length > 0 && (
        <button
          type="button"
          onClick={() => updateFollowing(true)}
          className="edge-lit animate-rise absolute bottom-[calc(0.75rem+var(--transcript-bottom-inset,0px))] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-overlay px-3 py-1 text-[11px] text-ink-mid transition-colors hover:text-ink"
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
          {t("transcript.view.jumpToLatest")}
        </button>
      )}

      {menu !== null && (
        <SelectionContextMenu
          x={menu.x}
          y={menu.y}
          markdown={menu.markdown}
          // copyFallback (not navigator.clipboard) so remote clients over
          // http://<lan-ip> without the async Clipboard API still work (#37).
          onCopy={() => void copyFallback(menu.text)}
          onCopyMarkdown={
            menu.markdown === null ? null : () => void copyFallback(menu.markdown!)
          }
          onComment={
            canComment && normalizeAnnotationQuote(menu.text) !== ""
              ? () => setComment({ quote: normalizeAnnotationQuote(menu.text), x: menu.x, y: menu.y })
              : null
          }
          onClose={() => setMenu(null)}
        />
      )}
      {commentButton.anchor !== null && (
        <SelectionCommentButton
          anchor={commentButton.anchor}
          onComment={() => {
            setComment(commentButton.anchor);
            commentButton.clear();
          }}
        />
      )}
      {comment !== null && tabId !== undefined && (
        <SelectionCommentPopover
          anchor={comment}
          onSave={(annotation) => {
            queueComposerAnnotations(tabId, [annotation]);
            window.getSelection()?.removeAllRanges();
          }}
          onClose={() => setComment(null)}
        />
      )}
    </div>
  );
}
