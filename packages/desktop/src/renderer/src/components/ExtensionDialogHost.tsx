import { useEffect, useMemo, useReducer, useRef } from "react";
import { cn } from "../lib/cn";
import { useCompactShell } from "../lib/responsive";
import { field, numField, strField } from "../lib/fields";
import { useT } from "../lib/i18n";
import { useAndroidBack } from "../lib/android-back";
import {
  checkedValues,
  isOtherRow,
  planSelect,
  readOptions,
  splitDialogTitle,
  togglePick,
} from "../lib/multi-select";
import {
  isAnswered,
  nextSeries,
  parsePage,
  recordAnswer,
  type SeriesEntry,
  type SeriesState,
} from "../lib/question-series";
import { dialogQuestion } from "../lib/session-tile";
import { useStore } from "../store";
import { AskFormCard } from "./AskFormCard";
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
 *
 * While the head frame accepts free text, the desktop composer doubles as
 * this card's "Other" field (issue #421): Enter there answers the frame
 * through `answerPendingQuestion` below, and the panel drops its own
 * textarea/input wherever a visible composer can hold that field.
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

/**
 * Whether the composer's draft can answer a frame as free text.
 * "answer": the text answers this frame outright — editor/input frames take
 * it verbatim. "other": a select whose rows include omp's Other row — the
 * text must go through that row, because `askChoice` matches a select reply
 * against its option labels and an unlisted value resolves to no option at
 * all, which cancels the whole ask (ask.ts: `labels.indexOf(outcome.value)`
 * → `option` undefined → the walk returns undefined). Answering the Other
 * row is what omp's "typed" branch accepts: it follows with an input (or,
 * on older omp, an editor) frame that collects the text. "none": not
 * answerable from the composer at all.
 */
export type FreeTextTarget = "answer" | "other" | "none";

export function freeTextTarget(frame: unknown): FreeTextTarget {
  const method = strField(frame, "method") ?? "";
  if (method === "editor" || method === "input") return "answer";
  if (method !== "select") return "none";
  const options = readOptions(field(frame, "options"));
  return options.some((o) => isOtherRow(o.label)) ? "other" : "none";
}

/**
 * "answered": the frame is gone, the composer may clear its draft.
 * "kept-draft": the sentinel went out; the draft belongs to the editor
 * frame that follows. "not-answerable": fall through to the prompt path.
 */
type AnswerOutcome = "answered" | "kept-draft" | "not-answerable";

// Registered by the live host per tab (see the effect in the component),
// so the composer reaches the question through one function and the
// series rail, picked-set reconstruction, and answered chips cannot drift.
const answerHandlers = new Map<string, (text: string) => AnswerOutcome>();

/** Route the composer's Enter into the tab's pending question, if any. */
export function answerPendingQuestion(tabId: string, text: string): AnswerOutcome {
  const handler = answerHandlers.get(tabId);
  return handler ? handler(text) : "not-answerable";
}

// The Skip & send route (issue #1234): registered only while a multi-question
// ask heads the queue, so one call site can never skip the wrong dialog.
const skipHandlers = new Map<string, () => void>();

/** Settle the tab's pending multi-question ask as cancelled without sending
 *  any partial answer — upstream sends no answers when a message skips an ask
 *  ("sending your message skips these questions"; the ask tool's partials
 *  only ride its local form path, never the wire). True when one was held. */
export function skipPendingQuestion(tabId: string): boolean {
  const handler = skipHandlers.get(tabId);
  if (handler === undefined) return false;
  handler();
  return true;
}

export interface ExtensionDialogState {
  inputValue: string;
  active: number;
  picked: string[] | null;
  series: SeriesState | null;
  reviewing: number | null;
  loopBase: string | null;
  lastSent: string | null;
}

export type ExtensionDialogAction =
  | { type: "request"; current: unknown; method: string }
  | { type: "input"; value: string }
  | { type: "active"; value: number }
  | { type: "review"; page: number | null }
  | { type: "record"; entry: SeriesEntry }
  | { type: "pick"; pending: string | null; entry?: SeriesEntry }
  | { type: "finish"; entry?: SeriesEntry };

export const INITIAL_EXTENSION_DIALOG_STATE: ExtensionDialogState = {
  inputValue: "",
  active: 0,
  picked: [],
  series: null,
  reviewing: null,
  loopBase: null,
  lastSent: null,
};

/** Pure state transition for request arrival and local dialog interaction. */
export function reduceExtensionDialog(
  state: ExtensionDialogState,
  action: ExtensionDialogAction,
): ExtensionDialogState {
  if (action.type === "input") return { ...state, inputValue: action.value };
  if (action.type === "active") return { ...state, active: action.value };
  if (action.type === "review") return { ...state, reviewing: action.page };
  if (action.type === "record") {
    return state.series === null
      ? state
      : { ...state, series: recordAnswer(state.series, action.entry) };
  }
  if (action.type === "pick" || action.type === "finish") {
    const series =
      action.entry !== undefined && state.series !== null
        ? recordAnswer(state.series, action.entry)
        : state.series;
    return {
      ...state,
      series,
      lastSent: action.type === "pick" ? action.pending : null,
    };
  }

  if (!action.current) return { ...state, inputValue: "" };
  const title = strField(action.current, "title") ?? "";
  const frameOptions = readOptions(field(action.current, "options"));
  // The 18.20.0 prompt title is `context\n\nquestion`; every parse below works
  // on the question line so context text never masquerades as the question.
  const pageFrame = parsePage(
    action.method === "select"
      ? planSelect(title, []).base
      : (splitDialogTitle(title).question.split("\n", 1)[0] ?? ""),
  );
  // Editor and input frames are the free-text legs of a question (the Other
  // follow-up on every omp, askText's editor from 18.18) — they continue the
  // live page rather than ending the series. 18.18.3+ asks carry no `(i/n)`
  // marker at all, so a markerless walk simply has no rail to keep.
  const series =
    pageFrame.page !== null
      ? nextSeries(state.series, pageFrame)
      : action.method === "editor" || action.method === "input"
        ? state.series
        : null;
  const common = { ...state, inputValue: "", series, reviewing: null };
  if (action.method !== "select") {
    // The editor frame opens on its `prefill` — the field's current value
    // (ask.ts askText) — so a prefilled answer submits edited, never blank.
    return { ...common, inputValue: strField(action.current, "prefill") ?? "", active: 0 };
  }

  const parsed = planSelect(title, frameOptions);
  // From 18.20.0 every select frame carries the cursor it opens on
  // (`initialIndex`): the preselected option of a radio group, or omp's
  // checkbox cursor on a loop frame. Authoritative when present; legacy
  // frames keep their own continuity.
  const initial = numField(action.current, "initialIndex");
  const opened =
    initial !== undefined && Number.isInteger(initial) && initial >= 0 && initial < parsed.listed.length
      ? initial
      : null;
  // 18.20.0 checkbox frames carry the checked set outright; the toggle
  // reconstruction below is only needed for frames old enough to omit it.
  const authoritative = checkedValues(action.current, frameOptions);
  if (authoritative !== null) {
    return {
      ...common,
      active: opened ?? state.active,
      picked: authoritative,
      loopBase: parsed.base,
      lastSent: null,
    };
  }
  if (parsed.count === null || parsed.base !== state.loopBase) {
    return {
      ...common,
      active: opened ?? 0,
      picked: parsed.count === null ? [] : null,
      loopBase: parsed.base,
      lastSent: null,
    };
  }
  const next = state.lastSent === null ? state.picked : togglePick(state.picked, state.lastSent);
  return {
    ...common,
    active: opened ?? state.active,
    picked: next !== null && next.length === parsed.count ? next : null,
    lastSent: null,
  };
}

export function ExtensionDialogHost({
  tabId,
  composerVisible = true,
}: {
  tabId: string;
  /** False where no visible composer can answer: the sheet, the subagent view, a hidden floating composer. */
  composerVisible?: boolean;
}) {
  const t = useT();
  const queue = useStore((s) => s.rpc[tabId]?.extensionQueue) ?? [];
  const answerExtension = useStore((s) => s.answerExtension);
  const current = queue[0];
  const root = useRef<HTMLDivElement>(null);
  useAndroidBack({ open: current !== undefined, refs: root, kind: "blocker", onBack: "block" });

  const [dialog, dispatch] = useReducer(
    reduceExtensionDialog,
    INITIAL_EXTENSION_DIALOG_STATE,
  );
  const { inputValue, active, picked, series, reviewing } = dialog;
  const priorFocus = useRef<HTMLElement | null>(null);
  const firstChoice = useRef<HTMLButtonElement | null>(null);
  const hadRequest = useRef(false);
  const keydown = useRef<(event: KeyboardEvent) => void>(() => {});
  const compact = useCompactShell();
  // Where the composer is mounted and visible it owns the free-text field;
  // everywhere else the panel keeps its own (issue #421).
  const panelField = compact || !composerVisible;

  const method = strField(current, "method") ?? "";
  const rawTitle = strField(current, "title") ?? t("dialog.extension.fallbackTitle");
  const options = useMemo(() => readOptions(field(current, "options")), [current]);

  const plan = method === "select" ? planSelect(rawTitle, options) : null;
  /** Multi-select is recognizable from the loop frames omp sends (legacy),
   *  or — from 18.20.0 — from the frame's own checkbox selection marker,
   *  which a group's *first* frame carries before any `(N selected)` prefix
   *  exists. */
  const inMultiLoop =
    plan !== null && (plan.count !== null || strField(current, "selectionMarker") === "checkbox");

  // Each request gets its own draft. The pure reducer keeps multi-select and
  // question-series continuity together, without refs mutated from a state updater.
  useEffect(() => {
    dispatch({ type: "request", current, method });
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
    // Answer-capable desktop frames leave the caret in the composer, which
    // can answer them; the card takes focus only where it owns the keyboard.
    if (current && method === "select" && (compact || freeTextTarget(current) === "none"))
      firstChoice.current?.focus({ preventScroll: true });
  }, [current, method, compact]);

  keydown.current = (e) => {
    if (!current || fromTextField(e)) return;
    const listed = plan?.listed ?? [];
    if (reviewing !== null) {
      // Review swallows every key — the live options stay untouched, and
      // Escape must NOT send {cancelled:true}: it returns to the question.
      const answeredPages =
        series?.entries.filter((entry) => entry.answer.length > 0).map((entry) => entry.page) ?? [];
      const index = answeredPages.indexOf(reviewing);
      if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "review", page: null });
      } else if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        dispatch({ type: "review", page: answeredPages[index - 1] });
      } else if (e.key === "ArrowRight" && index !== -1) {
        e.preventDefault();
        dispatch({
          type: "review",
          page: index + 1 < answeredPages.length ? answeredPages[index + 1] : null,
        });
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
      dispatch({ type: "active", value: (active + 1) % listed.length });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      dispatch({ type: "active", value: (active - 1 + listed.length) % listed.length });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (plan.doneValue !== null) finishMulti();
      else {
        const choice = listed[active];
        if (choice) pick(choice.value);
      }
    } else if (e.key === " " && plan.doneValue !== null) {
      e.preventDefault();
      const choice = listed[active];
      if (choice) pick(choice.value);
    }
  };

  // One subscription for the host's lifetime; the ref supplies current state.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keydown.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The composer's Enter consults this registry at call time. No dependency
  // list: the handler is re-registered every render so its closure sees the
  // current frame, plan, and series state (same ref-lifetime as the keydown
  // subscription above); the cleanup drops any stale handler once the head
  // frame is gone or the host unmounts.
  useEffect(() => {
    if (current !== undefined) {
      answerHandlers.set(tabId, answerWithText);
      // Skip & send (#1234): while a multi-question ask heads the queue, the
      // composer may settle it cancelled with its draft. An ask never takes
      // free text (freeTextTarget reads "none"), so this is its only route.
      if (method === "ask") {
        skipHandlers.set(tabId, () => answerExtension(tabId, current, { cancelled: true }));
      }
    }
    return () => {
      answerHandlers.delete(tabId);
      skipHandlers.delete(tabId);
    };
  });

  if (!current) return null;

  // From 18.20.0 the prompt title is `context\n\nquestion`: the header shows
  // the question, the form text around it renders separately below.
  const dialogTitle = splitDialogTitle(rawTitle);
  const title = plan ? plan.base : (dialogTitle.question.split("\n", 1)[0] ?? "");
  // A multi-question ask carries no title at all (issue #1234): the card's
  // header names the form; every question renders in the body below.
  const displayTitle =
    method === "ask"
      ? t("dialog.extension.ask.title")
      : (dialogQuestion(current) ?? t("dialog.extension.fallbackTitle"));
  const message = strField(current, "message") ?? strField(current, "label") ?? "";
  const reviewEntry =
    reviewing !== null && series !== null
      ? series.entries.find((e) => e.page === reviewing)
      : undefined;
  const cancel = () => answerExtension(tabId, current, { cancelled: true });
  /**
   * Answer with an option label. Only real options are recorded as pending
   * toggles — the Done sentinel and the Other row are loop affordances, and
   * folding them into the picked set would corrupt it. omp's Other row may
   * carry a disambiguation suffix (`Other (type your own) (2)`), so match it
   * by shape, never by the bare literal.
   */
  function pick(value: string): void {
    if (current === undefined) return;
    const other = plan?.listed.find((option) => option.value === value && isOtherRow(option.label));
    const entry =
      series !== null && plan !== null && (plan.doneValue === null || other !== undefined)
        ? {
            page: series.current,
            title: series.currentTitle,
            options: plan.listed,
            answer: other !== undefined ? [] : [plan.listed.find((option) => option.value === value)?.label ?? value],
            multi: false,
          }
        : undefined;
    dispatch({
      type: "pick",
      pending: other === undefined ? value : null,
      entry,
    });
    answerExtension(tabId, current, { value });
  }

  /** Finishes a multi-select loop page and records the picked set. */
  function finishMulti(): void {
    if (current === undefined || plan === null || plan.doneValue === null) return;
    const entry =
      series === null
        ? undefined
        : {
            page: series.current,
            title: series.currentTitle,
            options: plan.listed,
            answer:
              picked !== null && picked.length > 0
                ? [...picked]
                : [`${plan.count ?? 0} selected`],
            multi: true,
          };
    dispatch({ type: "finish", entry });
    answerExtension(tabId, current, { value: plan.doneValue });
  }

  /** Records a free-text submit as the live page's answer. */
  function recordFreeTextAnswer(value: string): void {
    if ((method !== "editor" && method !== "input") || series === null) return;
    dispatch({
      type: "record",
      entry: {
        page: series.current,
        title: series.currentTitle,
        options: [],
        answer: [value],
        multi: false,
      },
    });
  }

  /**
   * The composer's answer path (issue #421). Editor/input frames take the
   * text verbatim. A select never takes unlisted text outright: `askChoice`
   * matches a select reply against its option labels and an unlisted value
   * resolves to no option, which cancels the whole ask (issue #1190). Text
   * that names a listed label goes out as that option — the same reply a
   * click sends, so it toggles on a loop page. Anything else answers the
   * frame's own Other row and keeps its draft: omp follows with an input
   * frame (an editor on older builds) that collects the text with one more
   * Enter.
   */
  function answerWithText(text: string): AnswerOutcome {
    if (current === undefined || text.trim() === "") return "not-answerable";
    const target = freeTextTarget(current);
    if (target === "none") return "not-answerable";
    if (method === "editor" || method === "input") {
      recordFreeTextAnswer(text);
      answerExtension(tabId, current, { value: text });
      return "answered";
    }
    const listed = plan?.listed ?? [];
    const exact = listed.find((option) => option.label === text);
    if (exact !== undefined) {
      pick(exact.value);
      return "answered";
    }
    const otherRow = listed.find((option) => isOtherRow(option.label));
    if (otherRow === undefined) return "not-answerable";
    pick(otherRow.value);
    return "kept-draft";
  }

  return (
    <div ref={root} role={compact ? "dialog" : undefined} aria-modal={compact ? "false" : undefined} className={cn(
      "animate-rise shrink-0",
      compact
        ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[min(70dvh,var(--app-viewport-height,70dvh))] flex-col border-t border-line bg-raised pb-[var(--safe-bottom)]"
        : "pointer-events-auto mx-auto mb-2 w-full max-w-[var(--transcript-max)] rounded-md border border-line ambient glass-surface shadow-float",
    )}>
      <div className={cn("px-4 pt-3", compact && "sticky top-0 z-10 shrink-0 bg-raised pb-3")}>
        {series !== null && series.total > 1 && (
          <SeriesRail
            state={series}
            reviewing={reviewing}
            onReview={(page) => dispatch({ type: "review", page })}
            onJumpToCurrent={() => dispatch({ type: "review", page: null })}
          />
        )}
        <div className="flex items-start gap-2">
          <Dot tone="signal" pulse className="mt-1.5" title={t("dialog.extension.waiting")} />
          <h2 className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-snug text-ink">
            {reviewEntry !== undefined ? reviewEntry.title : displayTitle}
          </h2>
          {reviewEntry !== undefined && <Chip tone="signal">{t("dialog.extension.answered")}</Chip>}
          {inMultiLoop && (plan.count ?? 0) + (picked?.length ?? 0) > 0 && (
            <Chip tone="iris" mono title={t("dialog.extension.pickedTitle")}>
              {t("dialog.extension.selected", { n: plan.count ?? picked?.length ?? 0 })}
            </Chip>
          )}
          {queue.length > 1 && (
            <Chip tone="copper">{t("dialog.extension.more", { n: queue.length - 1 })}</Chip>
          )}
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
                          "mt-px grid size-3.5 shrink-0 place-items-center border text-xs leading-none",
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
              <p className="whitespace-pre-wrap break-words rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink">
                {reviewEntry.answer[0]}
              </p>
            )}
            {reviewEntry.answer.length === 1 &&
              reviewEntry.options.length > 0 &&
              !reviewEntry.options.some(
                (o) => o.label === reviewEntry.answer[0] || o.value === reviewEntry.answer[0],
              ) && <p className="mt-2 text-xs text-ink-dim">{reviewEntry.answer[0]}</p>}
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-ink-faint">{t("dialog.extension.reviewFinal")}</span>
              <Button variant="outline" size="xs" onClick={() => dispatch({ type: "review", page: null })}>
                {t("dialog.extension.backToQuestion", { n: series.current })}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {dialogTitle.context !== "" && (
              /* 18.20.0 prompt titles are `context\n\nquestion`: the header is
                 the question, the form text around it rides here. */
              <p className="mb-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-faint">
                {dialogTitle.context}
              </p>
            )}
            {message && (
              <p className="mb-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
                {message}
              </p>
            )}

            {/* The one-frame multi-question ask (issue #1234): the whole form
                lives in AskFormCard; every path out — submit, Escape, cancel —
                answers through answerExtension like the other methods. */}
            {method === "ask" && (
              <AskFormCard
                key={strField(current, "id") ?? ""}
                frame={current}
                onAnswer={(response) => answerExtension(tabId, current, response)}
              />
            )}

            {method === "confirm" && (
              <div className="flex justify-end gap-2">
                <Button onClick={() => answerExtension(tabId, current, { confirmed: false })}>
                  {t("dialog.extension.cancel")}
                </Button>
                <Button
                  variant="solid"
                  tone="signal"
                  onClick={() => answerExtension(tabId, current, { confirmed: true })}
                >
                  {t("dialog.extension.confirm")}
                </Button>
              </div>
            )}

            {plan !== null && (
              <>
                {plan.listed.length === 0 && <p className="rounded-md border border-line p-3 text-xs text-ink-dim">{t("dialog.extension.noChoices")}</p>}
                <div className="space-y-1">
                {plan.listed.map((option, i) => {
                  const isPicked = picked?.includes(option.value) ?? false;
                  const other = isOtherRow(option.label);
                  return (
                    <button
                      ref={i === 0 ? firstChoice : undefined}
                      key={`${option.value}:${i}`}
                      type="button"
                      onMouseEnter={() => dispatch({ type: "active", value: i })}
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
                            "mt-px grid size-3.5 shrink-0 place-items-center rounded-sm border text-xs leading-none",
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
                          {other ? t("dialog.extension.other") : option.label}
                        </span>
                        {option.description && (
                          <span className="mt-0.5 block whitespace-pre-wrap break-words text-xs leading-snug text-ink-faint">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-ink-faint">
                    {plan.doneValue !== null
                      ? t("dialog.extension.multiHint")
                      : t("dialog.extension.singleHint")}
                  </span>
                  <span className="flex items-center gap-2">
                    <Button variant="ghost" size="xs" onClick={cancel}>
                      {t("dialog.extension.cancel")}
                    </Button>
                    {plan.doneValue !== null && (
                      <Button
                        variant="solid"
                        tone="signal"
                        size="xs"
                        onClick={finishMulti}
                        title={t("dialog.extension.doneTitle")}
                      >
                        {t("dialog.extension.done")}
                      </Button>
                    )}
                  </span>
                </div>
                </div>
              </>
            )}

            {(method === "input" || method === "editor") && (
              <>
                {/* omp's editor titles carry the full prompt (ask's checkbox state
                    and "Enter your response:") — the header shows line one of the
                    question, the rest lands here, in either answer surface. The
                    18.20.0 context already rides in its own paragraph above. */}
                {method === "editor" && dialogTitle.question.includes("\n") && (
                  <p className="mb-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-faint">
                    {dialogTitle.question.split("\n").slice(1).join("\n").trim()}
                  </p>
                )}
                {/* Where the composer is visible it holds the field and answers
                    this frame on Enter (issue #421); the card keeps only its
                    cancel affordance — the draft stays put through the swap. */}
                {panelField ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      recordFreeTextAnswer(inputValue);
                      answerExtension(tabId, current, { value: inputValue });
                    }}
                  >
                    {method === "editor" ? (
                      <textarea
                        autoFocus
                        rows={3}
                        value={inputValue}
                        aria-label={message || title}
                        onChange={(e) => dispatch({ type: "input", value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancel();
                          } else if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            recordFreeTextAnswer(inputValue);
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
                        onChange={(e) => dispatch({ type: "input", value: e.target.value })}
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
                      <Button onClick={cancel}>{t("dialog.extension.cancel")}</Button>
                      <Button type="submit" variant="solid" tone="signal">
                        {t("dialog.extension.submit")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-ink-faint">
                      {t("dialog.extension.answerInComposer")}
                    </span>
                    <Button variant="ghost" size="xs" onClick={cancel}>
                      {t("dialog.extension.cancel")}
                    </Button>
                  </div>
                )}
              </>
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
  const t = useT();
  const compact = useCompactShell();
  const label =
    reviewing !== null
      ? t("dialog.extension.reviewing", { n: reviewing, total: state.total })
    : t("dialog.extension.question", { n: state.current, total: state.total });
  if (state.total > 10) {
    return (
      <div className="mb-2 flex items-center gap-2">
        <Meter fraction={state.current / state.total} className="w-24" title={label} />
        <span className="font-mono text-xs text-ink-faint">{label}</span>
      </div>
    );
  }
  return (
    <div className="mb-2 flex items-center gap-2">
      <ol className="flex items-center gap-1.5" aria-label={t("dialog.extension.seriesProgress")}>
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
                aria-label={t("dialog.extension.questionAria", {
                  page,
                  total: state.total,
                  status: isCurrent ? t("dialog.extension.questionCurrent") : answered ? t("dialog.extension.answered") : t("dialog.extension.questionNotAnswered")
                }) + (isViewing ? t("dialog.extension.questionReviewing") : "")}
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
                      ? "active-halo size-2.5 bg-signal"
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
      <span className="ml-auto font-mono text-xs text-ink-faint">{label}</span>
    </div>
  );
}
