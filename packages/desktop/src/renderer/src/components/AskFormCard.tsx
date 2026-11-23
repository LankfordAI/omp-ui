import { useEffect, useMemo, useReducer, useRef } from "react";
import type { AskDialogAnswer, AskDialogQuestion } from "@omp-ui/core/ask-dialog";
import { askDialogResponse, parseAskQuestions } from "@omp-ui/core/ask-dialog";
import { cn } from "../lib/cn";
import { field } from "../lib/fields";
import { Button } from "./ui";

/**
 * The multi-question `ask` form (issue #1234): one scrollable card above the
 * composer carrying every question of a single `method: "ask"` frame — the
 * shape omp emits once `set_ask_dialog` opts the host in. Answers stay local
 * until Submit or dismissal: partial answers remain editable, and Escape (the
 * host's existing dismissal rule) and Skip & send both answer `{cancelled}`.
 *
 * Question navigation mirrors the native card (omp `ask-dialog.ts`):
 * activating a single-select option advances to the next unanswered question,
 * and once none is left it submits the whole form (`#submitOrOpenUnanswered`
 * — Enter with nowhere left to send "submits anyway, the rest go
 * unanswered"); a click or Space-equivalent flips a multi-select in place.
 * Open questions sit expanded, answered ones collapse to one summary line
 * that reopens for editing — upstream folds every non-active question the
 * same way (`ask-fold.ts`). Tab/Shift-Tab move between questions; at the last
 * one plain Tab falls through to the Submit button.
 *
 * Every question offers free text — the wire never lists an "Other" option,
 * and `ask` rejects a single-select holding both an option and custom text,
 * so typing clears the pick and picking clears the text. The recommended
 * option carries its mark but is never preselected: on the wire a default is
 * omp's timeout answer, not the host's to invent (upstream puts a cursor on
 * it, nothing more).
 */

interface AskFormState {
  answers: Record<string, AskDialogAnswer>;
  /** The one open question; answered questions collapse beside it. */
  current: string | null;
}

type AskFormAction =
  | { type: "activate"; id: string; label: string }
  | { type: "toggle"; id: string; label: string }
  | { type: "custom"; id: string; value: string }
  | { type: "open"; id: string };

/** An answer counts as given once it holds a selection or typed text; an
 *  explicitly cleared multi-select reads as untouched (empty is empty). */
function isGiven(answer: AskDialogAnswer | undefined): boolean {
  if (answer === undefined) return false;
  return answer.selectedOptions.length > 0 || (answer.customInput?.trim() ?? "") !== "";
}

export function reduceAskForm(
  state: AskFormState,
  action: AskFormAction,
  questions: readonly AskDialogQuestion[],
): AskFormState {
  switch (action.type) {
    case "activate":
      return {
        answers: { ...state.answers, [action.id]: { selectedOptions: [action.label] } },
        current: state.current,
      };
    case "toggle": {
      const given = state.answers[action.id];
      const had = given?.selectedOptions.includes(action.label) === true;
      return {
        answers: {
          ...state.answers,
          [action.id]: {
            selectedOptions: had
              ? (given?.selectedOptions ?? []).filter((label) => label !== action.label)
              : [...(given?.selectedOptions ?? []), action.label],
            customInput: given?.customInput,
          },
        },
        current: state.current,
      };
    }
    case "custom": {
      // A single-select never sends an option and free text together.
      const question = questions.find((q) => q.id === action.id);
      return {
        answers: {
          ...state.answers,
          [action.id]:
            question !== undefined && !question.multi
              ? { selectedOptions: [], customInput: action.value }
              : { selectedOptions: state.answers[action.id]?.selectedOptions ?? [], customInput: action.value },
        },
        current: state.current,
      };
    }
    case "open":
      return { ...state, current: action.id };
  }
}

/** The first question without an answer; null when every one has one — the
 *  point where Enter past the last question submits. `beforeId` names the
 *  question being left, which counts as answered only through `answers`. */
function nextUnanswered(
  questions: readonly AskDialogQuestion[],
  answers: Record<string, AskDialogAnswer>,
): AskDialogQuestion | null {
  return questions.find((question) => !isGiven(answers[question.id])) ?? null;
}

export function AskFormCard({
  frame,
  onAnswer,
}: {
  frame: unknown;
  /** Sends the wire response for this frame (answers or cancelled). */
  onAnswer: (response: Record<string, unknown>) => void;
}) {
  const questions = useMemo(() => parseAskQuestions(field(frame, "questions")), [frame]);
  const [state, dispatch] = useReducer(
    (s: AskFormState, a: AskFormAction) => reduceAskForm(s, a, questions),
    { answers: {}, current: questions[0]?.id ?? null },
  );
  const fields = useRef(new Map<string, HTMLDivElement | null>());
  // Focus lands in the form's first open question when it opens, and follows
  // every open (click-to-edit, Enter-advance, Tab) — on the recommended
  // option's row where one exists, the card's cursor rule from upstream
  // (`#states`: cursorIndex starts at `recommended ?? 0`). The card only
  // mounts with an ask frame at the queue head, so mount IS the open.
  useEffect(() => {
    if (state.current === null) return;
    const container = fields.current.get(state.current);
    if (!container) return;
    const question = questions.find((q) => q.id === state.current);
    const cursor =
      question?.recommended === undefined
        ? null
        : container.querySelector<HTMLElement>(`[data-option-index="${question.recommended}"]`);
    (cursor ?? container.querySelector<HTMLElement>("button, input"))?.focus({ preventScroll: true });
  }, [state.current, questions]);

  const answeredCount = questions.filter((question) => isGiven(state.answers[question.id])).length;
  const dismiss = (): void => {
    onAnswer({ cancelled: true });
  };

  /** Option activation. A single-select advances to the next unanswered
   *  question and submits once none is left — omp's Enter rule; a
   *  multi-select flips in place. */
  function activate(question: AskDialogQuestion, label: string): void {
    if (question.multi) {
      dispatch({ type: "toggle", id: question.id, label });
      return;
    }
    const answers = { ...state.answers, [question.id]: { selectedOptions: [label] } };
    dispatch({ type: "activate", id: question.id, label });
    const next = nextUnanswered(questions, answers);
    if (next === null) onAnswer(askDialogResponse(questions, answers));
    else dispatch({ type: "open", id: next.id });
  }

  /** Enter in the free-text field: move to the next question still empty
   *  besides this one, else submit — a half-typed answer here with nowhere
   *  else to go sends the form as the native card does. */
  function advanceFromText(questionId: string): void {
    const next = questions.find((q) => q.id !== questionId && !isGiven(state.answers[q.id]));
    if (next === undefined) onAnswer(askDialogResponse(questions, state.answers));
    else dispatch({ type: "open", id: next.id });
  }

  /** Tab/Shift-Tab walk the questions; at the first or last the key falls
   *  through so the panel stays keyboard-reachable outward. */
  function moveQuestion(questionId: string, delta: number): boolean {
    const index = questions.findIndex((q) => q.id === questionId);
    const next = index === -1 ? undefined : questions[index + delta];
    if (next === undefined) return false;
    dispatch({ type: "open", id: next.id });
    return true;
  }

  if (questions.length === 0) {
    return (
      <div>
        <p className="rounded-md border border-line p-3 text-xs text-ink-dim">No choices are available for this request.</p>
        <div className="flex justify-end pt-2">
          <Button variant="outline" size="xs" onClick={dismiss}>
            cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer(askDialogResponse(questions, state.answers));
      }}
    >
      <p className="mb-2 font-mono text-xs text-ink-faint">
        {`${answeredCount} of ${questions.length} answered`}
      </p>
      <ol className="space-y-1.5">
        {questions.map((question, index) => {
          const answer = state.answers[question.id];
          const open = question.id === state.current;
          const summary = answerText(answer);
          if (!open) {
            return (
              <li key={`${question.id}:${index}`}>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "open", id: question.id })}
                  aria-label={`edit your answer to: ${question.question}`}
                  className="flex w-full items-baseline gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-mid">{question.question}</span>
                  <span className="min-w-0 max-w-[55%] truncate font-mono text-xs text-signal">{summary}</span>
                </button>
              </li>
            );
          }
          return (
            <li key={`${question.id}:${index}`}>
              <div
                ref={(node) => {
                  fields.current.set(question.id, node);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Tab" && moveQuestion(question.id, e.shiftKey ? -1 : 1)) e.preventDefault();
                }}
                className="rounded-lg border border-line px-2.5 py-2"
              >
                <div className="flex items-baseline gap-2">
                  {question.header !== undefined && (
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                      {question.header}
                    </span>
                  )}
                  <h3 className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs font-medium leading-snug text-ink">
                    {question.question}
                  </h3>
                </div>
                <div className="mt-1.5 space-y-1">
                  {question.options.map((option, optionIndex) => {
                    const checked = answer?.selectedOptions.includes(option.label) ?? false;
                    return (
                      <div key={`${question.id}:${option.label}:${optionIndex}`}>
                        <button
                          type="button"
                          aria-pressed={checked}
                          data-option-index={optionIndex}
                          onClick={() => activate(question, option.label)}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                            checked ? "border-signal-dim bg-signal-wash" : "border-transparent hover:bg-hover",
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "mt-px grid size-3.5 shrink-0 place-items-center border text-xs leading-none",
                              question.multi ? "rounded-sm" : "rounded-full",
                              checked
                                ? "border-signal-dim bg-signal-wash text-signal"
                                : "border-line text-transparent",
                            )}
                          >
                            ✓
                          </span>
                          <span className="min-w-0">
                            <span className="block whitespace-pre-wrap break-words text-xs text-ink">
                              {option.label}
                              {question.recommended === optionIndex && (
                                <span className="ml-1.5 font-mono text-[10px] uppercase tracking-wide text-copper">
                                  recommended
                                </span>
                              )}
                            </span>
                            {option.description && (
                              <span className="mt-0.5 block whitespace-pre-wrap break-words text-xs leading-snug text-ink-faint">
                                {option.description}
                              </span>
                            )}
                          </span>
                        </button>
                        {checked && option.preview !== undefined && (
                          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-ink">
                            {option.preview}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                  <input
                    value={answer?.customInput ?? ""}
                    aria-label={`your own answer to: ${question.question}`}
                    placeholder="Other — type your own…"
                    onChange={(e) => dispatch({ type: "custom", id: question.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      // The host's window listener skips text fields, so this
                      // field carries the Escape dismissal and the Enter
                      // advance itself.
                      if (e.key === "Escape") {
                        e.preventDefault();
                        dismiss();
                      } else if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        advanceFromText(question.id);
                      }
                    }}
                    className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim"
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center justify-between pt-2">
        <span className="text-xs text-ink-faint">Tab moves between questions · Enter answers and moves on · Esc dismisses</span>
        <span className="flex items-center gap-2">
          <Button variant="ghost" size="xs" onClick={dismiss}>
            cancel
          </Button>
          <Button type="submit" variant="solid" tone="signal" size="xs" title="send the answers you chose">
            submit
          </Button>
        </span>
      </div>
    </form>
  );
}

/** The collapsed line's answer text: chosen labels, plus the typed answer. */
function answerText(answer: AskDialogAnswer | undefined): string {
  const custom = answer?.customInput?.trim() ?? "";
  return [...(answer?.selectedOptions ?? []), ...(custom === "" ? [] : [custom])].join(", ");
}
