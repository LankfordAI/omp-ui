import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  formatBtwInjectText,
  splitBtwInject,
  type BtwImage,
  type BtwInjectParts,
  type BtwTopic,
  type BtwTurnStatus,
} from "@omp-ui/core/side-questions";
import { relativeTime } from "../lib/format";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { supportsBtwInject } from "../lib/btw-inject";
import { NATIVE_BTW_MIN_OMP, supportsNativeBtw } from "../lib/native-btw";
import { useStore } from "../store";
import { openImageViewer } from "./ImageViewer";
import { Markdown } from "./Markdown";
import { Button, Chip, Empty, IconButton, IconRefresh, type Tone } from "./ui";

/**
 * The Side questions rail pane (issue #682, native since #775): the `/btw`
 * exchanges asked against this session's context, none of which enter the
 * transcript. omp's native `btw` commands and the `btw_delta`/`btw_record`
 * frames build the snapshot; this pane only asks, cancels, and displays. A
 * file slash command whose frontmatter sets `side: true` opens here too,
 * titled by the command as typed (#955), and turns show their attached images.
 * Below the native-command version floor it renders itself unavailable and
 * dispatches nothing. On omp ≥ 18.16 an answer may draft a steering prompt
 * inside an `<inject>` block: the pane shows it as a railed mono block, and on
 * the topic's latest completed turn it offers one "inject into main session"
 * send per answer (issue #1029).
 */

const STATUS_TONE: Record<BtwTurnStatus, Tone> = {
  running: "copper",
  complete: "signal",
  cancelled: "neutral",
  error: "rose",
  interrupted: "neutral",
};

const STATUS_LABEL_KEY: Record<
  BtwTurnStatus,
  | "rail.btw.statusRunning"
  | "rail.btw.statusComplete"
  | "rail.btw.statusCancelled"
  | "rail.btw.statusError"
  | "rail.btw.statusInterrupted"
> = {
  running: "rail.btw.statusRunning",
  complete: "rail.btw.statusComplete",
  cancelled: "rail.btw.statusCancelled",
  error: "rail.btw.statusError",
  interrupted: "rail.btw.statusInterrupted",
};

const ANSWER_CLASS = "text-[12px] leading-relaxed text-ink-mid";

function AskBox({
  placeholder,
  buttonLabel,
  disabled,
  onSubmit,
}: {
  placeholder: string;
  buttonLabel: string;
  disabled: boolean;
  onSubmit: (question: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const question = draft.trim();
    if (disabled || question === "") return;
    onSubmit(question);
    setDraft("");
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-1.5">
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1 rounded-md border border-line bg-raised px-2 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-50"
      />
      <Button type="submit" size="xs" variant="outline" disabled={disabled || draft.trim() === ""}>
        {buttonLabel}
      </Button>
    </form>
  );
}

function TurnImages({ images }: { images: readonly BtwImage[] }) {
  const t = useT();
  const viewerImages = useMemo(
    () =>
      images.map((im, n) => ({
        src: `data:${im.mimeType};base64,${im.data}`,
        mimeType: im.mimeType,
        label: t("transcript.image.alt", { n: n + 1 }),
      })),
    [images, t],
  );
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((image, i) => (
        <button
          // Index-keyed deliberately: a turn's image list is fixed once
          // recorded, and the base64 payload is far too long a key.
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
            className="max-h-24 rounded border border-line-strong bg-sunken object-contain"
          />
        </button>
      ))}
    </div>
  );
}

/**
 * The railed display of one answer's `<inject>` block (issue #1029). The
 * store mark drives the label row so remounts keep the sent state; a failed
 * send returns the block to pending with a local retry notice. Only the
 * latest completed turn is sendable (`sendable`); running/earlier turns show
 * the block alone, plus any mark it already carries.
 */
function InjectBlock({
  tabId,
  turnKey,
  parts,
  sendable,
}: {
  tabId: string;
  turnKey: string | undefined;
  parts: BtwInjectParts;
  sendable: boolean;
}) {
  const t = useT();
  const mark = useStore((s) =>
    turnKey === undefined ? undefined : s.sideQuestionInjects[tabId]?.[turnKey],
  );
  const injectSideQuestion = useStore((s) => s.injectSideQuestion);
  const [failed, setFailed] = useState(false);
  const text = formatBtwInjectText(parts.inject);
  const send = (): void => {
    if (turnKey === undefined) return;
    setFailed(false);
    void injectSideQuestion(tabId, turnKey, text).then((ok) => {
      if (ok) return;
      // A refusal with no mark left by anyone else (another send or a blank
      // block): back to pending, so say the send did not happen.
      if (useStore.getState().sideQuestionInjects[tabId]?.[turnKey] === undefined)
        setFailed(true);
    });
  };
  return (
    <div className="space-y-1">
      <div
        className={cn(
          "rounded-r border-l-2 bg-sunken px-2 py-1.5 font-mono text-[11px] leading-relaxed",
          mark === "injected" ? "border-signal-dim text-ink-mid" : "border-copper-dim/60 text-ink-mid",
        )}
      >
        {text.split("\n").map((line, index) => (
          <p key={index} className="whitespace-pre-wrap break-words">
            {line === "" ? "\u00a0" : line}
          </p>
        ))}
      </div>
      {(mark !== undefined || (sendable && text !== "")) && (
        <div className="space-y-0.5">
          {mark === "injected" ? (
            <span className="text-[11px] text-signal">{`\u2197 ${t("rail.btw.injected")}`}</span>
          ) : mark === "sending" ? (
            <Button size="xs" variant="outline" disabled>
              {t("rail.btw.injecting")}
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={send}>
              {t("rail.btw.injectAction")}
            </Button>
          )}
          {failed && (
            <p role="alert" className="text-[11px] text-rose">
              {t("rail.btw.injectFailed")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Where an answer renders, and whether its `<inject>` block may be sent. */
interface AnswerContext {
  tabId: string;
  /** The 18.16 gate: off, every answer is plain Markdown as before. */
  injectGate: boolean;
  /** True while the turn streams: an unclosed block still shows railed. */
  running: boolean;
  turnKey: string | undefined;
  sendable: boolean;
}

/**
 * One answer as prose around its `<inject>` block (issue #1029). An unclosed
 * block is only ever a railed display while the turn runs — once the answer
 * is finished, upstream leaves it plain text, and so do we.
 */
function renderAnswer(answer: string, ctx: AnswerContext): ReactNode {
  const parts = ctx.injectGate ? splitBtwInject(answer) : undefined;
  if (parts === undefined || (!parts.closed && !ctx.running)) {
    return <Markdown text={answer} className={ANSWER_CLASS} />;
  }
  const before = parts.before.trim() !== "";
  const after = parts.after.trim() !== "";
  return (
    <>
      {before && <Markdown text={parts.before} className={ANSWER_CLASS} />}
      <InjectBlock tabId={ctx.tabId} turnKey={ctx.turnKey} parts={parts} sendable={ctx.sendable && parts.closed} />
      {after && <Markdown text={parts.after} className={ANSWER_CLASS} />}
    </>
  );
}

function TopicCard({
  topic,
  title,
  expanded,
  onToggle,
  followUpDisabled,
  onFollowUp,
  tabId,
  injectGate,
}: {
  topic: BtwTopic;
  title?: string;
  expanded: boolean;
  onToggle: () => void;
  followUpDisabled: boolean;
  onFollowUp: (question: string) => void;
  tabId: string;
  injectGate: boolean;
}) {
  const t = useT();
  const label = t(STATUS_LABEL_KEY[topic.status]);
  return (
    <div className="overflow-hidden rounded-md border border-line bg-raised">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full flex-col gap-1 px-2 py-1.5 text-left hover:bg-hover"
      >
        <span className="text-[12px] leading-snug text-ink">{title ?? topic.question}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Chip tone={STATUS_TONE[topic.status]}>{label}</Chip>
          <span className="text-[10px] text-ink-faint">
            {relativeTime(new Date(topic.updatedAt).toISOString())}
          </span>
          {topic.turns.length > 1 && (
            <span className="text-[10px] text-ink-faint">
              {t("rail.btw.turnCount", { count: topic.turns.length })}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2.5 border-t border-line-soft px-2 py-2">
          {topic.turns.map((turn, index) => (
            <div key={index} className="space-y-1">
              {index > 0 && <p className="text-[12px] font-medium leading-snug text-ink">{turn.question}</p>}
              {turn.images !== undefined && turn.images.length > 0 && <TurnImages images={turn.images} />}
              {turn.answer !== "" &&
                renderAnswer(turn.answer, {
                  tabId,
                  injectGate,
                  running: turn.status === "running",
                  // Matches upstream getBtwTurnKey; only the latest completed
                  // turn gets the send (issue #1029).
                  turnKey: `${topic.id}:${index}`,
                  sendable: index === topic.turns.length - 1 && turn.status === "complete",
                })}
              {turn.status === "running" && turn.answer === "" && (
                <p className="text-[11px] text-ink-faint">{t("rail.btw.thinking")}</p>
              )}
              {turn.error !== undefined && (
                <p role="alert" className="text-[11px] text-rose">
                  {turn.error}
                </p>
              )}
            </div>
          ))}
          <AskBox
            placeholder={t("rail.btw.followUpPlaceholder")}
            buttonLabel={t("rail.btw.followUp")}
            disabled={followUpDisabled || topic.status === "running"}
            onSubmit={onFollowUp}
          />
        </div>
      )}
    </div>
  );
}

export function SideQuestionsPane({ tabId }: { tabId: string }) {
  const t = useT();
  const snapshot = useStore((s) => s.rpc[tabId]?.sideQuestions) ?? null;
  const native = useStore((s) =>
    supportsNativeBtw(s.rpc[tabId]?.capabilities?.ompVersion ?? null),
  );
  const injectGate = useStore((s) =>
    supportsBtwInject(s.rpc[tabId]?.capabilities?.ompVersion ?? null),
  );
  const askSideQuestion = useStore((s) => s.askSideQuestion);
  const cancelSideQuestion = useStore((s) => s.cancelSideQuestion);
  const refreshSideQuestions = useStore((s) => s.refreshSideQuestions);
  const titles = useStore((s) => s.sideQuestionTitles);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Opening the pane re-reads the history files: topics from before a
  // hibernation, or written by omp's own TUI, appear without a new question.
  useEffect(() => {
    if (native) void refreshSideQuestions(tabId);
  }, [tabId, native, refreshSideQuestions]);

  const active = snapshot?.active ?? null;
  const topics = snapshot?.topics ?? [];
  const unavailable =
    !native || (snapshot !== null && !snapshot.available);
  const busy = active !== null;
  // A typed side command titles its topic; the running card shows the title
  // only while it is the topic's root turn, a follow-up shows its own question.
  const activeTopic = active === null ? undefined : topics.find((topic) => topic.id === active.topicId);
  const activeTitle =
    active === null
      ? undefined
      : activeTopic === undefined || activeTopic.turns.length <= 1
        ? titles[active.topicId]
        : undefined;

  return (
    <div className="space-y-2.5 px-3 py-2.5">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <AskBox
            placeholder={t("rail.btw.askPlaceholder")}
            buttonLabel={t("rail.btw.ask")}
            disabled={busy || unavailable}
            onSubmit={(question) => void askSideQuestion(tabId, question)}
          />
        </div>
        <IconButton label={t("rail.btw.refreshLabel")} onClick={() => void refreshSideQuestions(tabId)}>
          <IconRefresh />
        </IconButton>
      </div>

      {unavailable && (
        <p role="status" className="rounded-md border border-line bg-raised px-2 py-1.5 text-[11px] text-ink-mid">
          {/* A runtime-reported reason outranks everything; with the version
              gate closed the message names the required version, otherwise
              the generic line. */}
          {snapshot?.unavailableReason ??
            (native
              ? t("rail.btw.unavailable")
              : t("rail.btw.needsNewerOmp", { version: NATIVE_BTW_MIN_OMP }))}
        </p>
      )}
      {snapshot?.busy !== undefined && (
        <p role="status" className="rounded-md border border-copper-dim/50 bg-copper-wash px-2 py-1.5 text-[11px] text-copper">
          {snapshot.busy}
        </p>
      )}

      {active !== null && (
        <div className="space-y-1.5 rounded-md border border-copper-dim/50 bg-raised px-2 py-1.5" aria-live="polite">
          <div className="flex items-start gap-1.5">
            <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink">{activeTitle ?? active.question}</span>
            <Button size="xs" variant="outline" tone="rose" onClick={() => void cancelSideQuestion(tabId)}>
              {t("rail.btw.cancel")}
            </Button>
          </div>
          {active.answer === "" ? (
            <p className="text-[11px] text-ink-faint">{t("rail.btw.thinking")}</p>
          ) : (
            renderAnswer(active.answer, {
              tabId,
              injectGate,
              running: true,
              // The running turn is the topic's latest; it is never sendable —
              // a steering block only goes out once its answer is complete.
              turnKey: `${active.topicId}:${(activeTopic?.turns.length ?? 1) - 1}`,
              sendable: false,
            })
          )}
        </div>
      )}

      {topics.length === 0 && active === null ? (
        !unavailable && <Empty title={t("rail.btw.emptyTitle")} hint={t("rail.btw.emptyHint")} />
      ) : (
        <div className={cn("space-y-2")}>
          {topics
            // A brand-new topic is its running card; a follow-up's topic stays listed
            // so its earlier turns remain readable.
            .filter((topic) => active === null || topic.id !== active.topicId || topic.turns.length > 1)
            .map((topic) => (
              <TopicCard
                key={topic.id}
                topic={topic}
                title={titles[topic.id]}
                expanded={expanded === topic.id}
                onToggle={() => setExpanded((current) => (current === topic.id ? null : topic.id))}
                followUpDisabled={busy || unavailable}
                onFollowUp={(question) => void askSideQuestion(tabId, question, topic.id)}
                tabId={tabId}
                injectGate={injectGate}
              />
            ))}
        </div>
      )}
    </div>
  );
}
