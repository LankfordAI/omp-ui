import type { FormDialogChoiceField, FormDialogTextField } from "@omp-ui/core/form-dialog";

/**
 * The renderer-side half of the whole-HTML-form dialog (issue #1271): parse
 * the agent-authored `<form>` HTML from a `method: "form"` frame into safe,
 * structured sections, context blocks, and native controls.
 *
 * Security posture:
 * - HTML is parsed exclusively with `DOMParser` into an inert document (never
 *   inserted into the live DOM, never rendered via `dangerouslySetInnerHTML`,
 *   no scripts/styles/iframes/objects/embeds/event handlers survive).
 * - Text runs keep only semantic inline emphasis (`code`, `strong`, `em`) and
 *   render as plain React text nodes.
 * - Images never load remote (`http:`/`https:`), `file:`, or relative URLs
 *   from the renderer; only raster `data:image/(png|jpeg|gif|webp);base64,`
 *   URIs may render as `<img>`, while all other `<img>` and inline `<svg>`
 *   degrade to their safe `alt`/accessible label text.
 *
 * Parity with upstream `packages/tui/src/html-form/parse.ts`:
 * - Content outside the first `<form>` is ignored when a `<form>` exists.
 * - Radios and checkboxes group by `type + name`, never merging across types
 *   or with `<select>`.
 * - Single `<select>` defaults to its first enabled `<option>` when none has
 *   `selected`; `<select>` never gets host-added "Other".
 * - Radio/checkbox groups of 2+ options get host-added "Other" unless an
 *   option label matches `/^\s*other\b/i`.
 * - `<label>` wrapping, `<label for>`, `aria-label`, `title`, and validation
 *   constraints (`required`, `min`, `max`, `minlength`, `maxlength`,
 *   `pattern`) are extracted so the card validates before submitting.
 */

/** Inline emphasis kept from `<code>`, `<strong>`/`<b>`, and `<em>`/`<i>`. */
export type FormSpanStyle = "code" | "strong" | "em";

/** A run of plain inline text; `"\n"` inside `text` is a `<br>` break. */
export interface FormSpan {
  text: string;
  style?: FormSpanStyle;
}

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
  field: FormDialogChoiceField & { id: string };
  label: string;
  options: ParsedFormOption[];
}

/** One text-ish control with its display facts on top of the wire shape. */
export interface ParsedFormText {
  kind: "text";
  field: FormDialogTextField & { id: string };
  label: string;
  multiline: boolean;
  rows: number;
  value: string;
  placeholder: string;
  step?: string;
}

export type ParsedFormField = ParsedFormChoice | ParsedFormText;

/** One renderable unit inside a section, in document order. */
export type ParsedFormBlock =
  | { kind: "text"; spans: FormSpan[]; heading: boolean }
  | { kind: "list"; items: FormSpan[][]; ordered: boolean }
  | { kind: "pre"; text: string }
  | { kind: "table"; rows: FormSpan[][][]; headerRows: number }
  /** Safe raster data-URI image (or alt-only placeholder when `safeDataSrc` is null). */
  | { kind: "image"; safeDataSrc: string | null; alt: string }
  | { kind: "field"; field: ParsedFormField };

/** One `<fieldset>` (titled by `<legend>`) or loose content run between fieldsets. */
export interface ParsedFormSection {
  title: FormSpan[];
  blocks: ParsedFormBlock[];
  fieldset: boolean;
}

/** The whole readable form: structured sections in document order, plus flat fields. */
export interface ParsedFormHtml {
  /** Leading plain-text prose before the first control (for callers/summaries). */
  intro: string;
  sections: ParsedFormSection[];
  fields: ParsedFormField[];
}

const SKIPPED: Record<string, true> = {
  button: true,
  embed: true,
  head: true,
  iframe: true,
  link: true,
  meta: true,
  noscript: true,
  object: true,
  script: true,
  style: true,
  template: true,
  title: true,
};

const BLOCK: Record<string, true> = {
  address: true,
  article: true,
  aside: true,
  blockquote: true,
  dd: true,
  details: true,
  div: true,
  dl: true,
  dt: true,
  figure: true,
  figcaption: true,
  footer: true,
  header: true,
  li: true,
  main: true,
  nav: true,
  p: true,
  section: true,
};

const HEADING: Record<string, true> = {
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  summary: true,
};

const STYLE_OF: Record<string, FormSpanStyle> = {
  b: "strong",
  code: "code",
  em: "em",
  i: "em",
  kbd: "code",
  samp: "code",
  strong: "strong",
  tt: "code",
};

const IGNORED_INPUTS: Record<string, true> = {
  button: true,
  file: true,
  image: true,
  reset: true,
  submit: true,
};

const CONTROL_SELECTOR = "input, select, textarea";

/** Strictly allow offline raster data URIs only — never SVG, http(s), file, or relative paths. */
const SAFE_RASTER_DATA_URI = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
function groupName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim() || name;
}

function appendSpan(spans: FormSpan[], text: string, style: FormSpanStyle | undefined): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last && last.style === style) last.text += text;
  else spans.push(style ? { text, style } : { text });
}

function normalizeSpans(spans: FormSpan[]): FormSpan[] {
  const out: FormSpan[] = [];
  for (const span of spans) {
    const text = span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n");
    appendSpan(out, text, span.style);
  }
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter(span => span.text !== "");
}

export function spansPlainText(spans: readonly FormSpan[]): string {
  return spans.map(s => s.text).join("");
}

function numberAttr(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function svgTitle(svg: Element): string {
  const label = svg.getAttribute("aria-label")?.trim();
  if (label) return label;
  const title = Array.from(svg.children).find(child => child.localName === "title");
  return (title?.textContent ?? "").replace(/\s+/g, " ").trim();
}

class FormHtmlBuilder {
  readonly #root: Element;
  readonly #sections: ParsedFormSection[] = [];
  readonly #fields: ParsedFormField[] = [];
  readonly #groups = new Map<string, ParsedFormChoice>();
  readonly #labelFor = new Map<string, Element>();
  #section: ParsedFormSection = { title: [], blocks: [], fieldset: false };
  #inline: FormSpan[] = [];
  #fieldsetDepth = 0;
  #nextId = 0;

  constructor(root: Element) {
    this.#root = root;
    this.#sections.push(this.#section);
  }

  build(): ParsedFormHtml {
    const ids = new Set<string>();
    for (const control of Array.from(this.#root.querySelectorAll(CONTROL_SELECTOR))) {
      const id = control.getAttribute("id");
      if (id) ids.add(id);
    }
    for (const label of Array.from(this.#root.querySelectorAll("label"))) {
      const target = label.getAttribute("for");
      if (target && ids.has(target) && !this.#labelFor.has(target)) {
        this.#labelFor.set(target, label);
      }
    }
    this.#children(this.#root, undefined);
    this.#flush(false);

    // Upstream host rule (docs/rpc.md & html-form/parse.ts): radio/checkbox
    // groups of 2+ options (never <select>) get a free-text "Other" answer
    // unless the group already offers an option labelled "Other…".
    for (const row of this.#fields) {
      if (row.kind !== "choice" || row.field.select || row.options.length < 2) continue;
      row.field.other = !row.options.some(option => /^\s*other\b/i.test(option.label));
    }

    const sections = this.#sections.filter(s => s.blocks.length > 0 || s.title.length > 0);
    const introParts: string[] = [];
    let hitField = false;
    for (const section of sections) {
      if (hitField) break;
      for (const block of section.blocks) {
        if (block.kind === "field") {
          hitField = true;
          break;
        }
        if (block.kind === "text") {
          const text = spansPlainText(block.spans).trim();
          if (text !== "") introParts.push(text);
        }
      }
    }
    return {
      intro: introParts.join(" "),
      sections,
      fields: this.#fields,
    };
  }

  #children(node: Node, style: FormSpanStyle | undefined): void {
    for (const child of Array.from(node.childNodes)) this.#walk(child, style);
  }

  #walk(node: Node, style: FormSpanStyle | undefined): void {
    if (node.nodeType === 8 /* COMMENT_NODE */) return;
    if (node.nodeType === 3 /* TEXT_NODE */) {
      appendSpan(this.#inline, node.nodeValue ?? "", style);
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (SKIPPED[tag]) return;
    switch (tag) {
      case "br":
        appendSpan(this.#inline, "\n", undefined);
        return;
      case "hr":
        this.#flush(false);
        return;
      case "input":
      case "select":
      case "textarea":
        this.#control(el, undefined);
        return;
      case "label":
        this.#label(el, style);
        return;
      case "fieldset":
        this.#fieldset(el);
        return;
      case "legend":
        this.#flush(false);
        this.#children(el, style);
        this.#flush(true);
        return;
      case "ul":
      case "ol":
        this.#list(el, tag === "ol");
        return;
      case "pre":
        this.#flush(false);
        this.#section.blocks.push({
          kind: "pre",
          text: (el.textContent ?? "").replace(/^\r?\n/, "").trimEnd(),
        });
        return;
      case "table":
        this.#table(el);
        return;
      case "img": {
        const src = el.getAttribute("src")?.trim() ?? "";
        if (!src) return;
        this.#flush(false);
        this.#section.blocks.push({
          kind: "image",
          safeDataSrc: SAFE_RASTER_DATA_URI.test(src) ? src : null,
          alt: (el.getAttribute("alt") ?? "").trim(),
        });
        return;
      }
      case "svg": {
        this.#flush(false);
        const alt = svgTitle(el);
        if (alt !== "") {
          this.#section.blocks.push({ kind: "image", safeDataSrc: null, alt });
        }
        return;
      }
    }
    if (HEADING[tag]) {
      this.#flush(false);
      this.#children(el, style);
      this.#flush(true);
      return;
    }
    if (BLOCK[tag]) {
      this.#flush(false);
      this.#children(el, style);
      this.#flush(false);
      return;
    }
    this.#children(el, STYLE_OF[tag] ?? style);
  }

  #flush(heading: boolean): void {
    const spans = normalizeSpans(this.#inline);
    this.#inline = [];
    if (spans.length > 0) this.#section.blocks.push({ kind: "text", spans, heading });
  }

  #spansOf(element: Element): FormSpan[] {
    const spans: FormSpan[] = [];
    const visit = (node: Node, style: FormSpanStyle | undefined): void => {
      if (node.nodeType === 8) return;
      if (node.nodeType === 3) {
        appendSpan(spans, node.nodeValue ?? "", style);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const tag = el.localName.toLowerCase();
      if (SKIPPED[tag] || tag === "input" || tag === "select" || tag === "textarea" || tag === "svg") return;
      if (tag === "br") {
        appendSpan(spans, "\n", undefined);
        return;
      }
      if (tag === "img") {
        appendSpan(spans, el.getAttribute("alt") ?? "", style);
        return;
      }
      if (BLOCK[tag] || HEADING[tag]) appendSpan(spans, " ", undefined);
      for (const child of Array.from(el.childNodes)) visit(child, STYLE_OF[tag] ?? style);
    };
    for (const child of Array.from(element.childNodes)) visit(child, undefined);
    return normalizeSpans(spans);
  }

  #label(label: Element, style: FormSpanStyle | undefined): void {
    const controls = Array.from(label.querySelectorAll(CONTROL_SELECTOR));
    if (controls.length === 0) {
      const target = label.getAttribute("for");
      if (target && this.#labelFor.get(target) === label) return;
      this.#children(label, style);
      return;
    }
    this.#flush(false);
    const text = spansPlainText(this.#spansOf(label));
    for (const control of controls) this.#control(control, text);
  }

  #fieldset(fieldset: Element): void {
    this.#flush(false);
    const legend = Array.from(fieldset.children).find(child => child.localName.toLowerCase() === "legend");
    if (this.#fieldsetDepth > 0) {
      if (legend) this.#walk(legend, undefined);
    } else {
      this.#startSection(legend ? this.#spansOf(legend) : [], true);
    }
    this.#fieldsetDepth++;
    for (const child of Array.from(fieldset.childNodes)) {
      if (child !== legend) this.#walk(child, undefined);
    }
    this.#flush(false);
    this.#fieldsetDepth--;
    if (this.#fieldsetDepth === 0) this.#startSection([], false);
  }

  #startSection(title: FormSpan[], fieldset: boolean): void {
    if (this.#section.blocks.length === 0 && this.#section.title.length === 0) {
      this.#section.title = title;
      this.#section.fieldset = fieldset;
      return;
    }
    this.#section = { title, blocks: [], fieldset };
    this.#sections.push(this.#section);
  }

  #list(list: Element, ordered: boolean): void {
    this.#flush(false);
    if (list.querySelector(CONTROL_SELECTOR)) {
      this.#children(list, undefined);
      this.#flush(false);
      return;
    }
    const items = Array.from(list.children)
      .filter(child => child.localName.toLowerCase() === "li")
      .map(item => this.#spansOf(item))
      .filter(spans => spans.length > 0);
    if (items.length > 0) this.#section.blocks.push({ kind: "list", items, ordered });
  }

  #table(table: Element): void {
    this.#flush(false);
    const rows = Array.from(table.querySelectorAll("tr")).filter(row => row.closest("table") === table);
    const cellsOf = (row: Element) =>
      Array.from(row.children).filter(cell => {
        const t = cell.localName.toLowerCase();
        return t === "td" || t === "th";
      });
    if (!table.querySelector(CONTROL_SELECTOR)) {
      const cells = rows.map(row => cellsOf(row).map(cell => this.#spansOf(cell)));
      let headerRows = 0;
      while (
        headerRows < rows.length &&
        (rows[headerRows]!.closest("thead") !== null ||
          cellsOf(rows[headerRows]!).every(cell => cell.localName.toLowerCase() === "th"))
      ) {
        headerRows++;
      }
      if (cells.some(row => row.length > 0)) {
        this.#section.blocks.push({ kind: "table", rows: cells, headerRows });
      }
      return;
    }
    // Decision matrix: a table containing controls.
    let header: string[] = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      if (cells.every(cell => cell.localName.toLowerCase() === "th") && !row.querySelector(CONTROL_SELECTOR)) {
        header = cells.map(cell => spansPlainText(this.#spansOf(cell)));
        continue;
      }
      const text: FormSpan[] = [];
      for (const cell of cells) {
        if (cell.querySelector(CONTROL_SELECTOR)) continue;
        const spans = this.#spansOf(cell);
        if (spans.length === 0) continue;
        if (text.length > 0) appendSpan(text, " · ", undefined);
        for (const span of spans) appendSpan(text, span.text, span.style);
      }
      if (text.length > 0) this.#section.blocks.push({ kind: "text", spans: text, heading: false });
      cells.forEach((cell, column) => {
        for (const control of Array.from(cell.querySelectorAll(CONTROL_SELECTOR))) {
          const own = control.closest("label");
          const spans = own && cell.contains(own) ? this.#spansOf(own) : this.#spansOf(cell);
          const label = spansPlainText(spans) || header[column] || "";
          this.#control(control, label);
        }
      });
    }
  }

  #detachedLabel(control: Element): string {
    const id = control.getAttribute("id");
    const label = id ? this.#labelFor.get(id) : undefined;
    if (label) return spansPlainText(this.#spansOf(label));
    const text = control.getAttribute("aria-label") ?? control.getAttribute("title");
    return text ? text.replace(/\s+/g, " ").trim() : "";
  }

  #control(control: Element, wrappingLabel: string | undefined): void {
    this.#flush(false);
    const name = control.getAttribute("name") ?? "";
    if (name === "") return;
    const tag = control.localName.toLowerCase();
    const required = control.hasAttribute("required");
    const resolvedLabel = (wrappingLabel && wrappingLabel.trim() !== "" ? wrappingLabel : this.#detachedLabel(control))
      .replace(/\s+/g, " ")
      .trim();

    if (tag === "select") {
      const multi = control.hasAttribute("multiple");
      const options: ParsedFormOption[] = Array.from(control.querySelectorAll("option")).map(opt => {
        const text = (opt.textContent ?? "").replace(/\s+/g, " ").trim();
        return {
          value: opt.getAttribute("value") ?? text,
          label: text,
          checked: opt.hasAttribute("selected"),
          disabled: opt.hasAttribute("disabled"),
        };
      });
      // Single select always has a selection: the first enabled option unless one is marked.
      if (!multi && !options.some(option => option.checked && !option.disabled)) {
        const first = options.find(option => !option.disabled);
        if (first) first.checked = true;
      }
      const id = `f${this.#nextId++}`;
      const row: ParsedFormChoice = {
        kind: "choice",
        field: {
          kind: "choice",
          id,
          name,
          multi,
          select: true,
          optionValues: options.map(o => o.value),
          disabledOptions: options.map(o => o.disabled),
          other: false,
          required,
        },
        label: resolvedLabel || groupName(name),
        options,
      };
      this.#addField(row);
      return;
    }

    if (tag === "textarea") {
      const rawRows = numberAttr(control, "rows");
      const rows = rawRows !== undefined && rawRows >= 1 ? Math.min(Math.round(rawRows), 20) : 4;
      const id = `f${this.#nextId++}`;
      this.#addField({
        kind: "text",
        field: {
          kind: "text",
          id,
          name,
          type: "textarea",
          required,
          minLength: numberAttr(control, "minlength"),
          maxLength: numberAttr(control, "maxlength"),
        },
        label: resolvedLabel || groupName(name),
        multiline: true,
        rows,
        value: (control.textContent ?? "").replace(/^\r?\n/, ""),
        placeholder: control.getAttribute("placeholder") ?? "",
      });
      return;
    }

    const type = (control.getAttribute("type") ?? "text").toLowerCase();
    if (IGNORED_INPUTS[type] || type === "hidden") return;

    if (type === "radio" || type === "checkbox") {
      const rawValue = control.getAttribute("value");
      const value = rawValue ?? "on";
      const disabled = control.hasAttribute("disabled");
      const option: ParsedFormOption = {
        value,
        label: resolvedLabel || (rawValue ?? name),
        checked: control.hasAttribute("checked"),
        disabled,
      };
      const key = `${type}\0${name}`;
      const existing = this.#groups.get(key);
      if (existing !== undefined) {
        existing.options.push(option);
        existing.field.optionValues.push(value);
        (existing.field.disabledOptions as boolean[]).push(disabled);
        if (required) existing.field.required = true;
        return;
      }
      const id = `f${this.#nextId++}`;
      const group: ParsedFormChoice = {
        kind: "choice",
        field: {
          kind: "choice",
          id,
          name,
          multi: type === "checkbox",
          select: false,
          optionValues: [value],
          disabledOptions: [disabled],
          other: false,
          required,
        },
        // Radio/checkbox group questions come from surrounding text/legend, so
        // keep an empty own-label unless the section carries none.
        label: "",
        options: [option],
      };
      this.#groups.set(key, group);
      this.#addField(group);
      return;
    }

    const id = `f${this.#nextId++}`;
    this.#addField({
      kind: "text",
      field: {
        kind: "text",
        id,
        name,
        type,
        required,
        min: numberAttr(control, "min"),
        max: numberAttr(control, "max"),
        minLength: numberAttr(control, "minlength"),
        maxLength: numberAttr(control, "maxlength"),
        pattern: control.getAttribute("pattern") ?? undefined,
      },
      label: resolvedLabel || groupName(name),
      multiline: type === "textarea",
      rows: type === "textarea" ? 4 : 1,
      value: control.getAttribute("value") ?? "",
      placeholder: control.getAttribute("placeholder") ?? "",
      step: control.getAttribute("step") ?? undefined,
    });
  }

  #addField(row: ParsedFormField): void {
    this.#fields.push(row);
    this.#section.blocks.push({ kind: "field", field: row });
  }
}

export function parseFormHtml(html: unknown): ParsedFormHtml {
  if (typeof html !== "string" || html === "") return { intro: "", sections: [], fields: [] };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return { intro: "", sections: [], fields: [] };
  }
  const root = doc.querySelector("form") ?? doc.body;
  if (!root) return { intro: "", sections: [], fields: [] };
  return new FormHtmlBuilder(root).build();
}
