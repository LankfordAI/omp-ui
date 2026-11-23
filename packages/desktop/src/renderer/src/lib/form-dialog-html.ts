import type { FormDialogField } from "@omp-ui/core/form-dialog";

/**
 * The renderer-side half of the whole-HTML-form dialog (issue #1271): read
 * the model's `<form>` HTML out of a `form` frame into the controls the card
 * draws. omp parses the same HTML with its own parser upstream
 * (`@oh-my-pi/pi-tui/html-form`) and revalidates the answer against that
 * parse, so this reader keeps exactly the facts the wire answer is built
 * from: control name, option `value`s in document order, checked defaults,
 * and the rules ("Other" free text on radio/checkbox groups of two or more
 * options without one of their own) upstream documents for hosts.
 */

/** One choice option as the card draws it. */
export interface ParsedFormOption {
  value: string;
  label: string;
  checked: boolean;
  disabled: boolean;
}

/** One choice group with its display facts on top of the wire shape. */
export interface ParsedFormChoice {
  kind: "choice";
  field: FormDialogField & { kind: "choice" };
  label: string;
  options: ParsedFormOption[];
}

/** One text-ish control with its display facts on top of the wire shape. */
export interface ParsedFormText {
  kind: "text";
  field: FormDialogField & { kind: "text" };
  label: string;
  multiline: boolean;
  rows: number;
  value: string;
  placeholder: string;
}

export type ParsedFormField = ParsedFormChoice | ParsedFormText;

/** The whole readable form: prose ahead of the controls, and the controls. */
export interface ParsedFormHtml {
  /** Text content of everything before the first control (the question text). */
  intro: string;
  fields: ParsedFormField[];
}

/** A group's own question for radio/checkbox sets: the preceding label text, else the name. */
function groupName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim() || name;
}

function optionLabel(el: Element): string {
  const label = el.closest("label");
  const raw = (label ?? el).textContent ?? "";
  return raw.replace(/\s+/g, " ").trim();
}

export function parseFormHtml(html: unknown): ParsedFormHtml {
  if (typeof html !== "string" || html === "") return { intro: "", fields: [] };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  } catch {
    return { intro: "", fields: [] };
  }
  const root = doc.body;
  // Scripts, styles and form-submission chrome never reach the card.
  for (const junk of root.querySelectorAll("script, style, link, meta, button, input[type=submit]")) {
    junk.remove();
  }
  const fields: ParsedFormField[] = [];
  const choiceByName = new Map<string, ParsedFormChoice>();
  // Prose the card shows above the controls: everything except a control and
  // its own label text (option labels render with their rows, group legends
  // become the row header). A radio-group question normally rides outside its
  // option labels, so it survives this cut.
  const introRoot = root.cloneNode(true) as Element;
  for (const junk of Array.from(introRoot.querySelectorAll("label, input, textarea, select, script, style"))) {
    junk.remove();
  }
  const intro = (introRoot.textContent ?? "").replace(/\s+/g, " ").trim();
  for (const el of Array.from(root.querySelectorAll("input[name], textarea[name], select[name]"))) {
    const name = el.getAttribute("name") ?? "";
    if (name === "") continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (tag === "input" && (type === "hidden" || type === "submit" || type === "button" || type === "reset")) {
      continue;
    }
    if (tag === "select" || type === "radio" || type === "checkbox") {
      const multi = tag === "select" ? el.hasAttribute("multiple") : type === "checkbox";
      let group = choiceByName.get(name);
      if (group === undefined) {
        const labelEl = el.closest("label")?.parentElement ?? el.parentElement;
        const groupLabel =
          tag === "select"
            ? (el.closest("label")?.textContent ?? groupName(name)).replace(/\s+/g, " ").trim()
            : (labelEl?.querySelector("legend")?.textContent ?? "").replace(/\s+/g, " ").trim() ||
              groupName(name);
        group = {
          kind: "choice",
          field: { kind: "choice", name, multi, optionValues: [], other: false },
          label: groupLabel,
          options: [],
        };
        choiceByName.set(name, group);
        fields.push(group);
      }
      if (tag === "select") {
        for (const opt of Array.from(el.querySelectorAll("option"))) {
          group.field.optionValues.push(opt.getAttribute("value") ?? opt.textContent?.trim() ?? "");
          group.options.push({
            value: opt.getAttribute("value") ?? opt.textContent?.trim() ?? "",
            label: (opt.textContent ?? "").replace(/\s+/g, " ").trim(),
            checked: opt.hasAttribute("selected"),
            disabled: opt.hasAttribute("disabled"),
          });
        }
      } else {
        const value = el.getAttribute("value") ?? "on";
        group.field.optionValues.push(value);
        group.options.push({
          value,
          label: optionLabel(el),
          checked: el.hasAttribute("checked"),
          disabled: el.hasAttribute("disabled"),
        });
      }
      continue;
    }
    // input text-ish or textarea
    const multiline = tag === "textarea" || type === "textarea";
    const text: ParsedFormText = {
      kind: "text",
      field: { kind: "text", name },
      label:
        (el.closest("label")?.textContent ?? groupName(name)).replace(/\s+/g, " ").trim() ||
        groupName(name),
      multiline,
      rows: Number(el.getAttribute("rows") ?? "") || 4,
      value: tag === "textarea" ? (el.textContent ?? "").replace(/^\r?\n/, "") : el.getAttribute("value") ?? "",
      placeholder: el.getAttribute("placeholder") ?? "",
    };
    fields.push(text);
  }

  // Host rule from docs/rpc.md: radio/checkbox groups of two or more options
  // get a free-text "Other" unless the form already offers an option of that
  // own label. The name, not the index, keys the wire answer.
  for (const field of fields) {
    if (field.kind !== "choice") continue;
    field.field.other =
      field.options.length >= 2 && !field.options.some(o => o.label.toLowerCase() === "other");
  }

  return { intro, fields };
}
