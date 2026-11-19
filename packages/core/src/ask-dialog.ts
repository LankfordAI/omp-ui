/**
 * The multi-question `ask` dialog (issue #1234). `set_ask_dialog` opts the
 * host in to omp's one-frame ask: instead of walking an extension's
 * `ui.askDialog` call field by field through `select`/`input`/`editor`, omp
 * emits a single `extension_ui_request { method: "ask", questions }` and
 * blocks on one `extension_ui_response` carrying every answer. Off by default
 * per process; a build without the command answers with a failed `response`
 * and keeps emitting the field-by-field walk, so enabling rides the boot rail
 * and nothing else gates it — the fallback is "the frame never arrives".
 *
 * Probed against both binaries (18.22.2 and 19.0.0): each accepts
 * `set_ask_dialog` with `{ enabled: true }` and emits the identical `ask`
 * frame; a timeout answers every question with its recommended option, else
 * its first, ON OMP'S SIDE, and emits `cancel { targetId }` naming the ask
 * frame — which the host treats as dismissed (#1191 rule), never answerable.
 *
 * The response wire shape is strict-upstream (`parseAskDialogResponse` throws
 * on any mismatch): one entry per question in request order with equal ids,
 * `selectedOptions` of exact labels without duplicates, a multi-select may be
 * empty, a single-select takes at most one option and never both an option
 * and `customInput`, and `customInput` is trimmed and dropped when empty.
 * Unanswered questions go out as EMPTY entries — never invented defaults: the
 * native card's own submit does exactly this (upstream `#submitOrOpenUnanswered`,
 * "it submits anyway (the rest go unanswered)"), and defaulting is omp's
 * timeout rule alone, not a host answer. The renderer builds every answer
 * through {@link askDialogResponse}; it never hand-assembles answer frames.
 */

/** Fixed id so spawn tests can assert it; same idiom as EVENT_FILTER_COMMAND_ID. */
export const ASK_DIALOG_COMMAND_ID = "omp-ui-ask-dialog-1";

/** The opt-in command, riding `initialCommands` exactly once per process —
 *  fresh spawn and hibernate-resume alike (ADR-0043 registration guarantee).
 *  Per docs/rpc.md only `extension_ui_response` and this command are handled
 *  during extension startup, so its rail position never matters. */
export function setAskDialogCommand(id = ASK_DIALOG_COMMAND_ID): object {
  return { id, type: "set_ask_dialog", enabled: true };
}

/** One option of an `ask` question, as the wire carries it. Never an "Other"
 *  entry — omp excludes it; hosts always offer free text themselves. */
export interface AskDialogOption {
  label: string;
  description?: string;
  preview?: string;
}

/** One question of an `ask` frame, as the wire carries it. */
export interface AskDialogQuestion {
  /** Correlation id: the answer entry must echo it exactly. */
  id: string;
  question: string;
  header?: string;
  options: AskDialogOption[];
  multi: boolean;
  /** Index into `options` of the recommended option — the one a timeout
   *  answers, and the one worth marking `(Recommended)` in the UI. */
  recommended?: number;
}

/** The host's in-progress answer to one question: chosen labels plus optional
 *  free text. A single-select never holds both (the wire rejects that). */
export interface AskDialogAnswer {
  selectedOptions: string[];
  customInput?: string;
}

/** Reads one `ask` frame's questions; a malformed or missing list reads as
 *  empty, which renders the inert "no questions" card rather than throwing —
 *  omp blocks on the reply either way, so the card must never disappear on a
 *  parse failure. Id-less entries drop: no answer can echo them. */
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
      ...(Number.isInteger(record.recommended) && (record.recommended as number) >= 0
        ? { recommended: record.recommended as number }
        : {}),
    });
  }
  return questions;
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

/** The answer body for one `ask` request: exactly one entry per question, in
 *  request order, echoing each id. Questions missing from the answers record —
 *  never touched before Submit — go out as empty selections (see the file
 *  header for why upstream calls that "the rest go unanswered"). */
export function askDialogResponse(
  questions: AskDialogQuestion[],
  answers: Record<string, AskDialogAnswer>,
): { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> } {
  return {
    answers: questions.map((question) => {
      const given = answers[question.id];
      const custom = given?.customInput?.trim() ?? "";
      return {
        id: question.id,
        selectedOptions: [...(given?.selectedOptions ?? [])],
        ...(custom === "" ? {} : { customInput: custom }),
      };
    }),
  };
}
