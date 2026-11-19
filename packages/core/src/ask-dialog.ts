/**
 * The multi-question `ask` dialog (issue #1234). `set_ask_dialog` opts the
 * host in to omp's one-frame ask: instead of walking an extension's
 * `ui.askDialog` field by field through `select`/`input`/`editor`, omp emits
 * a single `extension_ui_request { method: "ask", questions }` and blocks on
 * one `extension_ui_response` carrying every answer. Off by default per
 * process; a build without the command answers with a failed `response` and
 * keeps emitting the field-by-field walk, so enabling rides the boot rail and
 * nothing else gates it — the fallback is "the frame never arrives".
 *
 * Verified against the real binaries (18.22.2 and 19.0.0): both accept
 * `set_ask_dialog` and emit the identical `ask` frame; a timeout answers every
 * question with its recommended option, else its first, and emits
 * `cancel { targetId }` naming the ask frame — which the host must treat as
 * dismissed (#1191 rule), never answerable.
 *
 * The response wire shape is strict-upstream (`parseAskDialogResponse` throws
 * on any mismatch): one entry per question in request order with equal ids,
 * `selectedOptions` of exact labels without duplicates, a multi-select may be
 * empty, a single-select takes at most one option and never both an option and
 * `customInput`, and `customInput` is trimmed and dropped when empty. Every
 * builder below produces that shape by construction — the renderer never
 * hand-assembles answer frames.
 */

/** Fixed id so spawn tests can assert it; same idiom as EVENT_FILTER_COMMAND_ID. */
export const ASK_DIALOG_COMMAND_ID = "omp-ui-ask-dialog-1";

/** The opt-in command, riding `initialCommands` exactly once per process —
 *  fresh spawn and hibernate-resume alike (ADR-0043 registration guarantee).
 *  Per docs/rpc.md it is one of the two commands handled during extension
 *  startup, so its position on the rail never matters. */
export function setAskDialogCommand(id = ASK_DIALOG_COMMAND_ID): object {
  return { id, type: "set_ask_dialog", enabled: true };
}

/** One question of an `ask` frame, as the wire carries it. */
export interface AskDialogQuestion {
  /** Correlation id: the answer entry must echo it exactly. */
  id: string;
  question: string;
  header?: string;
  options: AskDialogOption[];
  multi: boolean;
  /** Index into `options` of the preselected (recommended) option. */
  recommended?: number;
}

export interface AskDialogOption {
  label: string;
  description?: string;
  preview?: string;
}

/** The host's answer to one question: chosen labels plus optional free text. */
export interface AskDialogAnswer {
  selectedOptions: string[];
  customInput?: string;
}

/** Reads one `ask` frame's questions; a malformed or missing list reads as
 *  empty, which renders the inert "no questions" card rather than throwing —
 *  omp must still receive an answer or cancel, so the card never disappears
 *  on a parse failure. */
export function parseAskQuestions(raw: unknown): AskDialogQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: AskDialogQuestion[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") continue;
    if (typeof record.question !== "string") continue;
    questions.push({
      id: record.id,
      question: record.question,
      ...(typeof record.header === "string" ? { header: record.header } : {}),
      options: parseAskOptions(record.options),
      multi: record.multi === true,
      ...(isIndex(record.recommended) ? { recommended: record.recommended } : {}),
    });
  }
  return questions;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseAskOptions(raw: unknown): AskDialogOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AskDialogOption[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      options.push({ label: entry });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.label !== "string") continue;
    options.push({
      label: record.label,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(typeof record.preview === "string" ? { preview: record.preview } : {}),
    });
  }
  return options;
}

/**
 * The answer's default for one question — what a timeout submits upstream
 * (`timedOutAskDialogResult`): the recommended option, else the first. The
 * host starts every question here too, so an early submit answers "what was
 * answered plus these defaults", exactly like TUI Enter-on-answered-forms.
 */
export function askQuestionDefault(question: AskDialogQuestion): AskDialogAnswer {
  const fallback =
    question.options[question.recommended ?? 0] ?? question.options[0];
  return { selectedOptions: fallback ? [fallback.label] : [] };
}

/** True when the answer satisfies the wire rules for this question. */
export function askAnswerIsValid(
  question: AskDialogQuestion,
  answer: AskDialogAnswer,
): boolean {
  const labels = new Set(question.options.map((option) => option.label));
  if (answer.selectedOptions.some((label) => !labels.has(label))) return false;
  if (new Set(answer.selectedOptions).size !== answer.selectedOptions.length) return false;
  const custom = answer.customInput?.trim() ?? "";
  if (question.multi) return true;
  return answer.selectedOptions.length <= 1 && !(answer.selectedOptions.length === 1 && custom !== "");
}

/** The frame body answering one `ask` request: answers in question order with
 *  the question ids echoed. Questions absent from the answer record fall back
 *  to their default so the entry count always matches — a short list fails the
 *  whole ask call upstream. */
export function askDialogResponse(
  questions: AskDialogQuestion[],
  answers: Record<string, AskDialogAnswer>,
): { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> } {
  return {
    answers: questions.map((question) => {
      const given = answers[question.id] ?? askQuestionDefault(question);
      const custom = given.customInput?.trim() ?? "";
      return {
        id: question.id,
        selectedOptions: [...given.selectedOptions],
        ...(custom === "" ? {} : { customInput: custom }),
      };
    }),
  };
}
