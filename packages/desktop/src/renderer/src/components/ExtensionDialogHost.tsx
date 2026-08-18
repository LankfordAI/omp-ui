import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useCompactShell } from "../lib/responsive";
import { field, strField } from "../lib/fields";
import { OTHER_OPTION, planSelect, readOptions, togglePick } from "../lib/multi-select";
import {
  isAnswered,
  nextSeries,
  parsePage,
  recordAnswer,
  type SeriesEntry,
  type SeriesState,
} from "../lib/question-series";
import { useStore } from "../store";
import { Button, Chip, Dot, Meter } from "./ui";

/**
 * omp *blocks* on `extension_ui_response`, so every path out of this panel —
 * Escape, cancel button — must still send a reply. The payloads are protocol,
 * not UI: confirm → `{confirmed}`, select/editor → `{value}`, input →
 * `{value}`, abandon → `{cancelled:true}`.
 *
 * Deliberately *not* a modal: a question often needs the conversation to
 * answer it, so the panel docks above the composer and leaves the transcript
 * scrollable and readable. Keyboard nav therefore ignores events from text
 * fields — the composer keeps Enter/arrows/Escape while the user is typing.
 *
 * Multi-select (omp's ask tool with `multi: true`) is a *loop* of select
 * frames — see lib/multi-select.ts for the wire behavior. This host
 * reconstructs the picked set from the toggles it sent and verifies it
 * against the frame's `(N selected)` count.
 *
 * Multi-question asks carry a `(2/7)` page marker — lib/question-series.ts
 * tracks the series for a progress rail with read-only review of answered
 * pages. Review can never re-answer: the protocol has no revise message,
 * each answer is final the moment it is sent.
 */

/** True when the key event belongs to a text field, not to this panel. */
function fromTextField(e: KeyboardEvent): boolean {
  const t = e.target;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export function ExtensionDialogHost({ tabId }: { tabId: string }) {
  const queue = useStore((s) => s.rpc[tabId]?.extensionQueue) ?? [];
  const answerExtension = useStore((s) => s.answerExtension);
  const current = queue[0];

  const [inputValue, setInputValue] = useState("");
  const [active, setActive] = useState(0);
  /**
   * The reconstructed multi-select set for the loop in progress; null when
   * the host lost track (count mismatch, attach mid-loop). Keyed off the
   * question text via the plan's `base` — a different question resets it.
   */
  const [picked, setPicked] = useState<string[] | null>([]);
  /** The question series in progress; null for unpaged single dialogs. */
  const [series, setSeries] = useState<SeriesState | null>(null);
  /** The page under read-only review; null while on the live question. */
  const [reviewing, setReviewing] = useState<number | null>(null);
  /** The base question of the loop `picked` belongs to. */
  const loopBase = useRef<string | null>(null);
  /** The last toggle sent, pending confirmation by the next loop frame. */
  const lastSent = useRef<string | null>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const firstChoice = useRef<HTMLButtonElement | null>(null);
  const hadRequest = useRef(false);
  const compact = useCompactShell();

  const method = strField(current, "method") ?? "";
  const rawTitle = strField(current, "title") ?? "extension request";
  const options = useMemo(() => readOptions(field(current, "options")), [current]);

  const plan = method === "select" ? planSelect(rawTitle, options) : null;
  /** Multi-select is only recognizable from the loop frames omp sends. */
  const inMultiLoop = plan !== null && plan.count !== null;

  /** Records one page's answer into the series history (pure updater). */
  const record = (entry: SeriesEntry) =>
    setSeries((prev) => (prev ? recordAnswer(prev, entry) : prev));

  // Each request gets its own draft — a queued second dialog must not
  // inherit the first one's half-typed answer. The multi-select set instead
  // *survives* across frames of the same question: the arriving frame is the
  // loop continuing, and the toggle we sent for the previous frame is folded
  // in here, then verified against omp's count.
  useEffect(() => {
    setInputValue("");
    if (!current) return;
    // Series tracking: the page marker rides the count-stripped base of a
    // select frame. An editor frame ("Other") usually arrives marker-less and
    // continues the live page, so only non-editor frames without a marker
    // end the series. Reviewing always returns to the live request — which
    // also covers omp auto-resolving a timed-out request mid-review.
    const frame = parsePage(
      method === "select"
        ? planSelect(strField(current, "title") ?? "", []).base
        : (strField(current, "title") ?? "").split("\n", 1)[0],
    );
    if (frame.page !== null) setSeries((prev) => nextSeries(prev, frame));
    else if (method !== "editor") setSeries(null);
    setReviewing(null);
    if (method !== "select") {
      // An editor frame ("Other") belongs to the same ask loop — keep the
      // set so the panel still shows it when the loop resumes.
      setActive(0);
      return;
    }
    const parsed = planSelect(strField(current, "title") ?? "", []);
    // Consume the pending toggle outside setPicked — updaters must stay pure
    // (StrictMode invokes them twice).
    const sent = lastSent.current;
    lastSent.current = null;
    if (parsed.count === null || parsed.base !== loopBase.current) {
      // A fresh question (or a single-select) starts a new, empty set; a
      // loop frame for a question we never saw the start of stays unknown.
      loopBase.current = parsed.base;
      setPicked(parsed.count === null ? [] : null);
      setActive(0);
      return;
    }
    // Same question, next loop frame: fold in the toggle we sent, then let
    // omp's count arbitrate. A mismatch means missed frames — show count
    // only. The cursor deliberately survives — resetting it would yank the
    // highlight to the top after every toggle.
    setPicked((prev) => {
      const next = sent === null ? prev : togglePick(prev, sent);
      return next !== null && next.length === parsed.count ? next : null;
    });
  }, [current, method]);

  useEffect(() => {
    if (current && !hadRequest.current) {
      priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      hadRequest.current = true;
    } else if (!current && hadRequest.current) {
      hadRequest.current = false;
      priorFocus.current?.focus({ preventScroll: true });
      priorFocus.current = null;
    }
  }, [current]);

  useEffect(() => {
    if (current && method === "select") firstChoice.current?.focus({ preventScroll: true });
  }, [current, method]);

  useEffect(() => {
    if (!current) return;
    const listed = plan?.listed ?? [];
    const onKey = (e: KeyboardEvent) => {
      if (fromTextField(e)) return;
      if (reviewing !== null) {
        // Review swallows every key — the live options stay untouched, and
        // Escape must NOT send {cancelled:true}: it returns to the question.
        const answeredPages =
          series?.entries.filter((en) => en.answer.length > 0).map((en) => en.page) ?? [];
        const idx = answeredPages.indexOf(reviewing);
        if (e.key === "Escape") {
          e.preventDefault();
          setReviewing(null);
        } else if (e.key === "ArrowLeft" && idx > 0) {
          e.preventDefault();
          setReviewing(answeredPages[idx - 1]);
        } else if (e.key === "ArrowRight" && idx !== -1) {
          e.preventDefault();
          // Past the last answered page → back to the live question.
          if (idx + 1 < answeredPages.length) setReviewing(answeredPages[idx + 1]);
          else setReviewing(null);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        answerExtension(tabId, current, { cancelled: true });
        return;
      }
      if (plan === null || listed.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % listed.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + listed.length) % listed.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        // In a multi loop Enter finishes; the highlighted option is toggled
        // with Space instead — matching the checkbox mental model and
        // keeping "Enter = answer" truthful.
        if (plan.doneValue !== null) {
          finishMulti();
          return;
        }
        const choice = listed[active];
        if (choice) pick(choice.value);
      } else if (e.key === " " && plan.doneValue !== null) {
        e.preventDefault();
        const choice = listed[active];
        if (choice) pick(choice.value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!current) return null;

  const title = plan ? plan.base : rawTitle;
  const displayTitle = parsePage(method === "editor" ? title.split("\n", 1)[0] : title).base;
  const message = strField(current, "message") ?? strField(current, "label") ?? "";
  const reviewEntry =
    reviewing !== null && series !== null
      ? series.entries.find((e) => e.page === reviewing)
      : undefined;
  const cancel = () => answerExtension(tabId, current, { cancelled: true });
  /**
   * Answer with an option label. Only real options are recorded as pending
   * toggles — the Done sentinel and "Other" are loop affordances, and folding
   * them into the picked set would corrupt it.
   */
  function pick(value: string): void {
    if (current === undefined) return;
    lastSent.current = value === OTHER_OPTION ? null : value;
    // Series history: a single-select pick completes the page, while in a
    // multi loop an option click is a toggle — only the loop's done records
    // the answer. "Other" parks an options-only placeholder (dot stays
    // un-answered) that the editor submit completes.
    if (series !== null && plan !== null && (plan.doneValue === null || value === OTHER_OPTION)) {
      record({
        page: series.current,
        title: series.currentTitle,
        options: plan.listed,
        answer:
          value === OTHER_OPTION
            ? []
            : [plan.listed.find((o) => o.value === value)?.label ?? value],
        multi: false,
      });
    }
    answerExtension(tabId, current, { value });
  }

  /** Finishes a multi-select loop page and records the picked set. */
  function finishMulti(): void {
    if (current === undefined || plan === null || plan.doneValue === null) return;
    lastSent.current = null;
    // When the picked set was lost (or empty) the review falls back to the
    // frame's count text rather than faking checkmarks.
    if (series !== null) {
      record({
        page: series.current,
        title: series.currentTitle,
        options: plan.listed,
        answer: picked !== null && picked.length > 0 ? [...picked] : [`${plan.count ?? 0} selected`],
        multi: true,
      });
    }
    answerExtension(tabId, current, { value: plan.doneValue });
  }

  /** Records an editor submit as the live page's free-text answer. */
  function recordEditorAnswer(): void {
    if (method !== "editor" || series === null) return;
    record({
      page: series.current,
      title: series.currentTitle,
      options: [],
      answer: [inputValue],
      multi: false,
    });
  }

  return (
    <div role={compact ? "dialog" : undefined} aria-modal={compact ? "false" : undefined} className={cn(
      "animate-rise shrink-0",
      compact
        ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[min(70dvh,var(--app-viewport-height,70dvh))] flex-col border-t border-line bg-raised pb-[var(--safe-bottom)]"
        : "mx-auto mb-2 w-full max-w-3xl rounded-xl border border-line ambient plane-lit shadow-float",
    )}>
      <div className={cn("px-4 pt-3", compact && "sticky top-0 z-10 shrink-0 bg-raised pb-3")}>
        {series !== null && series.total > 1 && (
          <SeriesRail
            state={series}
            reviewing={reviewing}
            onReview={setReviewing}
            onJumpToCurrent={() => setReviewing(null)}
          />
        )}
        <div className="flex items-start gap-2">
          <Dot tone="signal" pulse className="mt-1.5" title="the agent is waiting on this answer" />
          <h2 className="min-w-0 flex-1 whitespace-pre-wrap break-words font-display text-sm leading-snug text-ink">
            {reviewEntry !== undefined ? reviewEntry.title : displayTitle}
          </h2>
          {reviewEntry !== undefined && <Chip tone="signal">answered</Chip>}
          {inMultiLoop && (
            <Chip tone="iris" mono title="answers picked so far — picking again removes one">
              {plan.count} selected
            </Chip>
          )}
          {queue.length > 1 && <Chip tone="copper">{queue.length - 1} more</Chip>}
        </div>
      </div>

      {/* The panel caps its own height so a long option list never buries the
          composer or the transcript; the list scrolls inside instead. */}
      <div className={cn("max-h-[38vh] overflow-y-auto px-4 py-3", compact && "max-h-none min-h-0 flex-1 overscroll-contain")}>
        {reviewing !== null && series !== null && reviewEntry !== undefined ? (
          <div>
            {reviewEntry.options.length > 0 && (
              <div className="space-y-1">
                {reviewEntry.options.map((option, i) => {
                  const chosen =
                    reviewEntry.answer.includes(option.label) ||
                    reviewEntry.answer.includes(option.value);
                  return (
                    <div
                      key={`${option.value}:${i}`}
                      className="flex items-start gap-2 rounded-lg border border-transparent px-2.5 py-1.5"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "mt-px grid size-3.5 shrink-0 place-items-center border text-[9px] leading-none",
                          reviewEntry.multi ? "rounded-sm" : "rounded-full",
                          chosen
                            ? "border-signal-dim bg-signal-wash text-signal"
                            : "border-line text-transparent",
                        )}
                      >
                        ✓
                      </span>
                      <span
                        className={cn(
                          "whitespace-pre-wrap break-words text-xs",
                          chosen ? "text-signal" : "text-ink-dim",
                        )}
                      >
                        {option.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {reviewEntry.answer.length > 0 && reviewEntry.options.length === 0 && (
              <p className="whitespace-pre-wrap break-words rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink">
                {reviewEntry.answer[0]}
              </p>
            )}
            {reviewEntry.answer.length === 1 &&
              reviewEntry.options.length > 0 &&
              !reviewEntry.options.some(
                (o) => o.label === reviewEntry.answer[0] || o.value === reviewEntry.answer[0],
              ) && <p className="mt-2 text-xs text-ink-dim">{reviewEntry.answer[0]}</p>}
            <div className="flex items-center justify-between pt-2">
              <span className="text-[10px] text-ink-faint">
                answers are final once sent · Esc back
              </span>
              <Button variant="outline" size="xs" onClick={() => setReviewing(null)}>
                back to question {series.current}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {message && (
              <p className="mb-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
                {message}
              </p>
            )}

            {method === "confirm" && (
              <div className="flex justify-end gap-2">
                <Button onClick={() => answerExtension(tabId, current, { confirmed: false })}>
                  cancel
                </Button>
                <Button
                  variant="solid"
                  tone="signal"
                  onClick={() => answerExtension(tabId, current, { confirmed: true })}
                >
                  confirm
                </Button>
              </div>
            )}

            {plan !== null && (
              <>
                {plan.listed.length === 0 && <p className="rounded-md border border-line p-3 text-xs text-ink-dim">No choices are available for this request.</p>}
                <div className="space-y-1">
                {plan.listed.map((option, i) => {
                  const isPicked = picked?.includes(option.value) ?? false;
                  const other = option.label === OTHER_OPTION;
                  return (
                    <button
                      ref={i === 0 ? firstChoice : undefined}
                      key={`${option.value}:${i}`}
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(option.value)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                        i === active
                          ? "border-line-strong bg-hover"
                          : "border-transparent hover:bg-hover",
                        other && "text-ink-dim",
                      )}
                    >
                      {inMultiLoop && !other && (
                        <span
                          aria-hidden
                          className={cn(
                            "mt-px grid size-3.5 shrink-0 place-items-center rounded-sm border text-[9px] leading-none",
                            isPicked
                              ? "border-signal-dim bg-signal-wash text-signal"
                              : "border-line text-transparent",
                          )}
                        >
                          ✓
                        </span>
                      )}
                      {!inMultiLoop && !other && (
                        <span
                          aria-hidden
                          className={cn(
                            "mt-px grid size-3.5 shrink-0 place-items-center rounded-full border",
                            i === active ? "border-signal-dim" : "border-line",
                          )}
                        >
                          {i === active && <span className="size-1.5 rounded-full bg-signal" />}
                        </span>
                      )}
                      <span className="min-w-0">
                        <span
                          className={cn(
                            "block whitespace-pre-wrap break-words text-xs",
                            isPicked ? "text-signal" : "text-ink",
                          )}
                        >
                          {other ? "Other — type your own…" : option.label}
                        </span>
                        {option.description && (
                          <span className="mt-0.5 block whitespace-pre-wrap break-words text-[11px] leading-snug text-ink-faint">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                <div className="flex items-center justify-between pt-2">
                  <span className="text-[10px] text-ink-faint">
                    {plan.doneValue !== null
                      ? "↑↓ move · Space or click toggles · Enter done · Esc dismiss"
                      : "↑↓ choose · Enter answer · Esc dismiss"}
                  </span>
                  <span className="flex items-center gap-2">
                    <Button variant="ghost" size="xs" onClick={cancel}>
                      cancel
                    </Button>
                    {plan.doneValue !== null && (
                      <Button
                        variant="solid"
                        tone="signal"
                        size="xs"
                        onClick={finishMulti}
                        title="finish selecting and send the answer"
                      >
                        done selecting
                      </Button>
                    )}
                  </span>
                </div>
                </div>
              </>
            )}

            {(method === "input" || method === "editor") && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  recordEditorAnswer();
                  answerExtension(tabId, current, { value: inputValue });
                }}
              >
                {/* omp's editor titles carry the full prompt (ask's checkbox state
                    and "Enter your response:") — the header shows line one, the
                    rest lands here. */}
                {method === "editor" && rawTitle.includes("\n") && (
                  <p className="mb-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-faint">
                    {rawTitle.split("\n").slice(1).join("\n").trim()}
                  </p>
                )}
                {method === "editor" ? (
                  <textarea
                    autoFocus
                    rows={3}
                    value={inputValue}
                    aria-label={message || title}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancel();
                      } else if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        recordEditorAnswer();
                        answerExtension(tabId, current, { value: inputValue });
                      }
                    }}
                    className="mb-3 w-full resize-y rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim"
                  />
                ) : (
                  <input
                    autoFocus
                    value={inputValue}
                    aria-label={message || title}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      // The window listener skips text fields, so Escape-to-dismiss
                      // is restored here for the panel's own input.
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancel();
                      }
                    }}
                    className="mb-3 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim"
                  />
                )}
                <div className="flex justify-end gap-2">
                  <Button onClick={cancel}>cancel</Button>
                  <Button type="submit" variant="solid" tone="signal">
                    submit
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The series progress rail: one dot per question — filled signal once
 * answered (ADR-0004 success semantics), a larger breathing dot on the live
 * question, hollow for upcoming. Answered dots open the read-only review.
 * Past ten questions the dots would overflow a phone shell, so the rail
 * degrades to the Meter primitive plus the same label.
 */
function SeriesRail({
  state,
  reviewing,
  onReview,
  onJumpToCurrent,
}: {
  state: SeriesState;
  reviewing: number | null;
  onReview: (page: number) => void;
  onJumpToCurrent: () => void;
}) {
  const compact = useCompactShell();
  const label =
    reviewing !== null
      ? `Reviewing ${reviewing} of ${state.total}`
      : `Question ${state.current} of ${state.total}`;
  if (state.total > 10) {
    return (
      <div className="mb-2 flex items-center gap-2">
        <Meter fraction={state.current / state.total} className="w-24" title={label} />
        <span className="font-mono text-[10px] text-ink-faint">{label}</span>
      </div>
    );
  }
  return (
    <div className="mb-2 flex items-center gap-2">
      <ol className="flex items-center gap-1.5" aria-label="question series progress">
        {Array.from({ length: state.total }, (_, i) => i + 1).map((page) => {
          const answered = isAnswered(state, page);
          const isCurrent = page === state.current;
          const isViewing = reviewing === page;
          return (
            <li key={page}>
              <button
                type="button"
                disabled={!answered && !isCurrent}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`question ${page} of ${state.total}, ${
                  isCurrent ? "current" : answered ? "answered" : "not answered"
                }${isViewing ? ", reviewing" : ""}`}
                onClick={() => (isCurrent ? onJumpToCurrent() : onReview(page))}
                className={cn(
                  "grid place-items-center rounded-full transition-colors",
                  compact ? "size-7" : "size-5",
                  "disabled:cursor-default",
                  (answered || isCurrent) && "hover:bg-hover",
                )}
              >
                <span
                  className={cn(
                    "rounded-full",
                    isCurrent
                      ? "size-2.5 bg-signal animate-breathe motion-reduce:animate-none"
                      : answered
                        ? "size-2 bg-signal"
                        : "size-2 border border-line-strong",
                    isViewing && "ring-2 ring-ink-dim/60",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ol>
      <span className="ml-auto font-mono text-[10px] text-ink-faint">{label}</span>
    </div>
  );
}
