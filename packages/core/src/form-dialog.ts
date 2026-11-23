/**
 * The whole-HTML-form dialog (issue #1271). From omp 19.1 the `ask` tool and
 * `ui.formDialog` send one `extension_ui_request { method: "form", html }`
 * carrying the model's `<form>` and block on one `extension_ui_response`
 * whose `data` is keyed by control name exactly as an HTML form submits —
 * omp revalidates it against its own parse before the tool sees it
 * (upstream `parseFormDialogResponse`), so any key the form does not declare,
 * or an entry of the wrong shape, throws on omp's side instead of guessing.
 *
 * The entry shapes mirror upstream's `choiceValue`/`textValue`:
 * a checkbox group with two or more options contributes an array of checked
 * values plus the free-text "Other" answer appended; every other control
 * contributes a single string (the typed Other replaces the checked value on
 * a one-option group, exactly as upstream's `typed || values[0]` does).
 * A choice left unanswered contributes nothing — the key is absent from
 * `data`, never an empty placeholder — because upstream treats a missing key
 * as the field's own default and enforces `required` itself. Hidden inputs
 * are never echoed: omp keeps the form's own hidden values either way.
 */

/** One choice group of the parsed form: radio (`multi` false) or checkbox. */
export interface FormDialogChoiceField {
  kind: "choice";
  name: string;
  multi: boolean;
  /** The option `value` attributes in document order. */
  optionValues: string[];
  /** True when the host must offer a free-text "Other" answer for this group. */
  other: boolean;
}

/** One text-ish control: `<input type=text|number|…>` or `<textarea>`. */
export interface FormDialogTextField {
  kind: "text";
  name: string;
}

export type FormDialogField = FormDialogChoiceField | FormDialogTextField;

/** The host's in-progress answer to one named control. */
export interface FormDialogSelection {
  /** Checked option values, in the field's own option order. */
  values?: readonly string[];
  /** The free-text "Other" answer of a choice group. */
  other?: string;
  /** The text (or textarea) content. */
  text?: string;
}

/** True when a checked-group answer ships as an array (upstream isArrayChoice). */
function isArrayChoice(field: FormDialogChoiceField): boolean {
  return field.multi && field.optionValues.length > 1;
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
): { data: Record<string, string | string[]> } {
  const data: Record<string, string | string[]> = {};
  for (const field of fields) {
    const selection = selections[field.name];
    if (selection === undefined) continue;
    if (field.kind === "text") {
      // Upstream accepts any string here and coerces numbers itself.
      if (selection.text === undefined) continue;
      data[field.name] = selection.text;
      continue;
    }
    const checked = new Set(selection.values ?? []);
    // A disabled option is not checkable in the card at all, so a value only
    // present as an answer cannot arrive; nothing to filter here.
    const values = field.optionValues.filter(value => checked.has(value));
    const typed = field.other ? selection.other?.trim() : undefined;
    if (isArrayChoice(field)) {
      if (values.length === 0 && (typed === undefined || typed === "")) continue;
      data[field.name] = typed !== undefined && typed !== "" ? [...values, typed] : values;
      continue;
    }
    const single = typed !== undefined && typed !== "" ? typed : values[0];
    if (single === undefined) continue;
    data[field.name] = single;
  }
  return { data };
}
