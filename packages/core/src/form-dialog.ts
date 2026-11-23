/**
 * The whole-HTML-form dialog (issue #1271). From omp 19.1 the `ask` tool and
 * `ui.formDialog` send one `extension_ui_request { method: "form", html }`
 * carrying the model's `<form>` and block on one `extension_ui_response`
 * whose `data` is keyed by control name exactly as an HTML form submits —
 * omp revalidates it against its own parse before the tool sees it
 * (upstream `parseFormDialogResponse`), so any key the form does not declare,
 * an entry of the wrong shape, or a constraint violation fails the whole
 * `ask` call without a correction round.
 *
 * The entry shapes and constraint checks mirror upstream's
 * `packages/tui/src/html-form/data.ts`:
 * - checkbox groups and multi-selects of two or more options ship an array
 *   of enabled checked option values (deduplicated, in document order) plus
 *   at most one trimmed "Other" answer appended;
 * - radios, single `<select>`s, and lone checkboxes ship a single string
 *   (typed Other replaces the option on a group that offers Other);
 * - text inputs and textareas ship their string, or a finite number for
 *   non-empty numeric `number`/`range` inputs;
 * - choices with nothing selected omit their key (upstream reads an absent
 *   array choice as `[]` and an absent single choice as `undefined`);
 * - hidden inputs are never echoed (omp keeps the form's own hidden values);
 * - keys are assigned with `Object.defineProperty` so a control named
 *   `__proto__` stays an ordinary JSON property instead of mutating the
 *   prototype chain.
 */

/** One choice group of the parsed form: radio (`multi` false), checkbox, or `<select>`. */
export interface FormDialogChoiceField {
  kind: "choice";
  /** Unique key within the form UI (distinct even when two controls share `name`). */
  id?: string;
  name: string;
  multi: boolean;
  /** True when the control came from a `<select>` (never gets host-added "Other"). */
  select?: boolean;
  /** The enabled/all option `value` attributes in document order. */
  optionValues: string[];
  /** Per-option disabled flags aligned with `optionValues`; absent means all enabled. */
  disabledOptions?: readonly boolean[];
  /** True when the host must offer a free-text "Other" answer for this group. */
  other: boolean;
  required?: boolean;
}

/** One text-ish control: `<input type=text|number|…>` or `<textarea>`. */
export interface FormDialogTextField {
  kind: "text";
  /** Unique key within the form UI (distinct even when two controls share `name`). */
  id?: string;
  name: string;
  /** HTML input type (`text`, `number`, `range`, `email`, `url`, `date`, …) or `textarea`. */
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export type FormDialogField = FormDialogChoiceField | FormDialogTextField;

/** The host's in-progress answer to one control. */
export interface FormDialogSelection {
  /** Checked option values, in any order (normalized to document order on submit). */
  values?: readonly string[];
  /** The free-text "Other" answer of a choice group. */
  other?: string;
  /** The text (or textarea) content. */
  text?: string;
}

export type FormDialogValue = string | number | string[];

/** Lookup key for a field inside a selections map: explicit `id`, else `name`. */
export function formFieldKey(field: FormDialogField): string {
  return field.id ?? field.name;
}

/** True when a choice field's answer ships as an array (upstream `isArrayChoice`). */
export function isArrayChoice(field: FormDialogChoiceField): boolean {
  return field.multi && field.optionValues.length > 1;
}

function lookupSelection(
  selections: Record<string, FormDialogSelection>,
  field: FormDialogField,
): FormDialogSelection | undefined {
  const key = formFieldKey(field);
  if (Object.prototype.hasOwnProperty.call(selections, key)) return selections[key];
  if (key !== field.name && Object.prototype.hasOwnProperty.call(selections, field.name)) {
    return selections[field.name];
  }
  return undefined;
}

function choiceFieldValue(
  field: FormDialogChoiceField,
  selection: FormDialogSelection | undefined,
): FormDialogValue | undefined {
  if (selection === undefined) return undefined;
  const checked = new Set(selection.values ?? []);
  const seen = new Set<string>();
  const values: string[] = [];
  for (let i = 0; i < field.optionValues.length; i++) {
    if (field.disabledOptions?.[i] === true) continue;
    const value = field.optionValues[i]!;
    if (!checked.has(value) || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  const rawTyped = field.other ? selection.other?.trim() : undefined;
  // Upstream rejects an "Other" string that duplicates a checked option or
  // matches a disabled option (when no enabled option has that value).
  const typed = rawTyped !== undefined && rawTyped !== "" ? rawTyped : undefined;
  if (isArrayChoice(field)) {
    if (values.length === 0 && typed === undefined) return undefined;
    if (typed !== undefined && !seen.has(typed)) return [...values, typed];
    return values;
  }
  return typed ?? values[0];
}

function textFieldValue(field: FormDialogTextField, text: string): FormDialogValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const num = Number(text);
    if (Number.isFinite(num)) return num;
  }
  return text;
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    try {
      return new RegExp(`^(?:${pattern})$`, "u");
    } catch {
      return undefined;
    }
  }
}

/**
 * Why a field's current selection would be rejected by omp 19.1's
 * `parseFormDialogResponse`, or undefined when it is valid. Mirrors upstream
 * `fieldError` (`packages/tui/src/html-form/data.ts`) plus the disabled-option
 * "Other" edge case so the host catches mistakes before failing the whole ask.
 */
export function formFieldError(
  field: FormDialogField,
  selection: FormDialogSelection | undefined,
): string | undefined {
  if (field.kind === "choice") {
    const typed = field.other ? selection?.other?.trim() : undefined;
    if (typed !== undefined && typed !== "") {
      const hasEnabled = field.optionValues.some(
        (v, i) => v === typed && field.disabledOptions?.[i] !== true,
      );
      const hasDisabled = field.optionValues.some(
        (v, i) => v === typed && field.disabledOptions?.[i] === true,
      );
      if (!hasEnabled && hasDisabled) {
        return `Option ${JSON.stringify(typed)} is disabled`;
      }
    }
    const value = choiceFieldValue(field, selection);
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return isArrayChoice(field) ? "Select at least one" : "Required";
  }
  const text = selection?.text ?? "";
  if (text.trim() === "") return field.required ? "Required" : undefined;
  if (field.type === "number" || field.type === "range") {
    const num = Number(text);
    if (!Number.isFinite(num)) return "Enter a number";
    if (field.min !== undefined && num < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && num > field.max) return `Must be at most ${field.max}`;
  }
  if (field.minLength !== undefined && text.length < field.minLength) {
    return `Needs at least ${field.minLength} characters`;
  }
  if (field.maxLength !== undefined && text.length > field.maxLength) {
    return `At most ${field.maxLength} characters`;
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
  if (field.type === "url") {
    try {
      new URL(text);
    } catch {
      return "Enter a full URL";
    }
  }
  if (field.pattern !== undefined && field.pattern !== "") {
    const regex = compilePattern(field.pattern);
    if (regex !== undefined && !regex.test(text)) {
      return `Must match ${field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern}`;
    }
  }
  return undefined;
}

/**
 * Validates all fields against their current selections. Returns a map of
 * `formFieldKey(field) -> errorMessage` for every invalid field.
 */
export function validateFormDialog(
  fields: readonly FormDialogField[],
  selections: Record<string, FormDialogSelection>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const err = formFieldError(field, lookupSelection(selections, field));
    if (err !== undefined) {
      Object.defineProperty(errors, formFieldKey(field), {
        value: err,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return errors;
}

/**
 * The one response body for a `form` request: `{ data }` keyed by control
 * name, carrying only fields with an answer. Fields outside the selection
 * record are skipped entirely — inventing defaults is omp's timeout rule,
 * not a host answer.
 */
export function formDialogResponse(
  fields: readonly FormDialogField[],
  selections: Record<string, FormDialogSelection>,
): { data: Record<string, FormDialogValue> } {
  const data: Record<string, FormDialogValue> = {};
  const setEntry = (name: string, value: FormDialogValue): void => {
    Object.defineProperty(data, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const field of fields) {
    if (field.name === "") continue;
    const selection = lookupSelection(selections, field);
    if (selection === undefined) continue;
    if (field.kind === "text") {
      if (selection.text === undefined) continue;
      const value = textFieldValue(field, selection.text);
      if (value !== "" || !Object.prototype.hasOwnProperty.call(data, field.name)) {
        setEntry(field.name, value);
      }
      continue;
    }
    const value = choiceFieldValue(field, selection);
    if (value === undefined) continue;
    setEntry(field.name, value);
  }
  return { data };
}
