import { useEffect, useState, type FormEvent } from "react";
import type { BtwTopic, BtwTurnStatus } from "@omp-ui/core/side-questions";
import { relativeTime } from "../lib/format";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { useStore } from "../store";
import { Markdown } from "./Markdown";
import { Button, Chip, Empty, IconButton, IconRefresh, type Tone } from "./ui";

/**
 * The Side questions rail pane (issue #682): the `/btw` exchanges asked against
 * this session's context, none of which enter the transcript. The bridge
 * publishes the whole picture; this pane only asks, cancels, and displays.
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

function TopicCard({
  topic,
  expanded,
  onToggle,
  followUpDisabled,
  onFollowUp,
}: {
  topic: BtwTopic;
  expanded: boolean;
  onToggle: () => void;
  followUpDisabled: boolean;
  onFollowUp: (question: string) => void;
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
        <span className="text-[12px] leading-snug text-ink">{topic.question}</span>
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
              {turn.answer !== "" && <Markdown text={turn.answer} className={ANSWER_CLASS} />}
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
  const askSideQuestion = useStore((s) => s.askSideQuestion);
  const cancelSideQuestion = useStore((s) => s.cancelSideQuestion);
  const refreshSideQuestions = useStore((s) => s.refreshSideQuestions);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Opening the pane re-reads the history files: topics from before a
  // hibernation, or written by omp's own TUI, appear without a new question.
  useEffect(() => {
    void refreshSideQuestions(tabId);
  }, [tabId, refreshSideQuestions]);

  const active = snapshot?.active ?? null;
  const topics = snapshot?.topics ?? [];
  const unavailable = snapshot !== null && !snapshot.available;
  const busy = active !== null;

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
          {snapshot?.unavailableReason ?? t("rail.btw.unavailable")}
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
            <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink">{active.question}</span>
            <Button size="xs" variant="outline" tone="rose" onClick={() => void cancelSideQuestion(tabId)}>
              {t("rail.btw.cancel")}
            </Button>
          </div>
          {active.answer === "" ? (
            <p className="text-[11px] text-ink-faint">{t("rail.btw.thinking")}</p>
          ) : (
            <Markdown text={active.answer} className={ANSWER_CLASS} />
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
                expanded={expanded === topic.id}
                onToggle={() => setExpanded((current) => (current === topic.id ? null : topic.id))}
                followUpDisabled={busy || unavailable}
                onFollowUp={(question) => void askSideQuestion(tabId, question, topic.id)}
              />
            ))}
        </div>
      )}
    </div>
  );
}
