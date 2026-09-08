/**
 * The authored HTML plan parsed once, with source ranges (issue #312
 * follow-up; supersedes the placeholder protocol of ADR-0022/0023).
 *
 * Every downstream transform works on zero-based UTF-16 offsets into the
 * ORIGINAL authored string, and the prepared document is composed once by
 * interleaving original slices with replacement strings. Nothing authored
 * ever passes through a JavaScript replacement string, so a `$'`, `$&`, or
 * `` $` `` inside a code block stays literal (issue #412) and an authored
 * comment that looks like a pipeline marker stays ordinary source.
 *
 * parse5 runs with `sourceCodeLocationInfo` (original ranges),
 * `scriptingEnabled: false` (a plan document is a document, not a script
 * host), and `onParseError` (HTML syntax diagnostics only — no style rules).
 * Decoded text comes from the parser, so entities decode exactly the way the
 * displayed document will decode them.
 */
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { PlanDiagnostic } from "@omp-ui/core/plan";
import { HIGHLIGHT_CHAR_CAP, resolveLang } from "./highlight";

/** parse5 v8 exports its default tree adapter's node types via a namespace. */
export type DefaultNode = DefaultTreeAdapterTypes.Node;
export type DefaultElement = DefaultTreeAdapterTypes.Element;
export type DefaultTextNode = DefaultTreeAdapterTypes.TextNode;
export type DefaultChildNode = DefaultTreeAdapterTypes.ChildNode;

/** Children of any adapter node — comment and doctype nodes carry none. */
export function childNodesOf(node: DefaultNode): DefaultChildNode[] {
  return "childNodes" in node ? node.childNodes : [];
}

/** The HTML namespace; foreign subtrees are scanned past, never into. */
export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
export const MATH_ML_NS = "http://www.w3.org/1998/Math/MathML";

/** One half-open original-source range. */
export interface PlanRange {
  startOffset: number;
  endOffset: number;
}

/**
 * One prepared-output mutation: original bytes in [startOffset, endOffset)
 * are replaced by `text` (empty for pure insertions). Ranges are
 * non-overlapping; composition interleaves them with the untouched slices.
 */
export interface PlanReplacement {
  startOffset: number;
  endOffset: number;
  text: string;
}

/** Attribute name → its full source range (`class="x"` incl. the name). */
export interface PlanAttr {
  name: string;
  value: string;
  range: PlanRange | null;
}

/** An element plus enough location detail to re-emit it byte-faithfully. */
export interface PlanElement {
  /** Whole element range, start tag through end tag. */
  range: PlanRange;
  /** Start tag range including `<` and `>`; null for synthesized nodes. */
  startTag: PlanRange | null;
  attrs: PlanAttr[];
  /** True when the authored source carries an explicit end tag. */
  hasEndTag: boolean;
  node: DefaultElement;
}

/** A `pre > code` block that the highlighter can transform. */
export interface PlanCodeBlock {
  kind: "code";
  /** Index among transformable code blocks, in document order. */
  blockIndex: number;
  pre: PlanElement;
  code: PlanElement;
  /** Canonical grammar name from the shared resolveLang table. */
  lang: string;
  /** Browser-decoded code text (entities resolved, dollar sequences literal). */
  sourceText: string;
  /** Range of the code element's inner content (the text being replaced). */
  inner: PlanRange;
}

/** A real HTML `pre.mermaid` diagram source. */
export interface PlanDiagramBlock {
  kind: "diagram";
  blockIndex: number;
  pre: PlanElement;
  /** Browser-decoded diagram source. */
  sourceText: string;
}

export type PlanBlock = PlanCodeBlock | PlanDiagramBlock;

export interface PlanStructure {
  /** Explicit `</head>` insert point, when the document has an explicit head end. */
  closingHeadOffset: number | null;
  /** Explicit `</body>` insert point. */
  closingBodyOffset: number | null;
  /** Right after the explicit `<html …>` start tag. */
  afterHtmlOpen: number | null;
  hasExplicitHtml: boolean;
  eofOffset: number;
}

export interface ParsedPlanSource {
  /** The original authored string; every offset indexes into it. */
  html: string;
  /** Source-stage diagnostics: parse5 errors plus structural findings. */
  diagnostics: PlanDiagnostic[];
  codeBlocks: PlanCodeBlock[];
  diagramBlocks: PlanDiagramBlock[];
  /** Structure insertion points, resolved from the parse tree. */
  structure: PlanStructure;
  /** The parsed document, for structural verification. */
  document: DefaultNode;
}

/** A `class` token list carrying the highlighter's `language-` convention. */
const LANGUAGE_CLASS = /^language-[\w+#-]+$/i;

function classTokens(el: PlanElement): string[] {
  const cls = el.attrs.find((a) => a.name === "class");
  return cls === undefined ? [] : cls.value.split(/[\t\n\f\r ]+/).filter(Boolean);
}

function hasClassToken(el: PlanElement, token: string): boolean {
  return classTokens(el).includes(token);
}

function languageFrom(el: PlanElement): string | null {
  const token = classTokens(el).find((t) => LANGUAGE_CLASS.test(t));
  return token === undefined ? null : token.slice("language-".length);
}

function elementOf(node: DefaultElement): PlanElement | null {
  const loc = node.sourceCodeLocation;
  if (!loc || loc.startOffset < 0) return null;
  const startTag =
    loc.startTag && loc.startTag.startOffset >= 0
      ? { startOffset: loc.startTag.startOffset, endOffset: loc.startTag.endOffset }
      : null;
  const attrs: PlanAttr[] = (node.attrs ?? []).map((attr) => {
    const aloc = loc.attrs?.[attr.name];
    return {
      name: attr.name,
      value: attr.value,
      range: aloc && aloc.startOffset >= 0
        ? { startOffset: aloc.startOffset, endOffset: aloc.endOffset }
        : null,
    };
  });
  return {
    range: { startOffset: loc.startOffset, endOffset: loc.endOffset },
    startTag,
    attrs,
    hasEndTag: Boolean(loc.endTag && loc.endTag.startOffset >= 0),
    node,
  };
}

function isElement(node: DefaultNode): node is DefaultElement {
  return (node as DefaultElement).tagName !== undefined;
}

function isHtmlElement(node: DefaultNode, tagName: string): node is DefaultElement {
  return isElement(node) && node.namespaceURI === HTML_NS && node.tagName === tagName;
}

/** Concatenated decoded text of a node's descendants (text nodes only). */
function decodedText(node: DefaultNode): string {
  if (node.nodeName === "#text") {
    // parse5's default tree adapter types #text as a value-carrying node;
    // the compiler cannot unify it across the nodeName switch.
    const text = node as DefaultTextNode;
    return text.value;
  }
  let out = "";
  for (const child of childNodesOf(node)) out += decodedText(child);
  return out;
}

/** Element descendants of a code/diagram body — markup that had to be escaped. */
function elementDescendants(node: DefaultNode): DefaultElement[] {
  const out: DefaultElement[] = [];
  for (const child of childNodesOf(node)) {
    if (child.nodeName === "#text" || child.nodeName === "#comment") continue;
    if (isElement(child)) {
      out.push(child, ...elementDescendants(child));
      continue;
    }
    out.push(...elementDescendants(child));
  }
  return out;
}

function locate(node: DefaultNode): PlanRange | null {
  const loc = node.sourceCodeLocation;
  if (!loc || loc.startOffset < 0) return null;
  return { startOffset: loc.startOffset, endOffset: loc.endOffset };
}

function located(
  code: PlanDiagnostic["code"],
  stage: PlanDiagnostic["stage"],
  repair: PlanDiagnostic["repair"],
  message: string,
  range: PlanRange | null,
  line: number | undefined,
  column: number | undefined,
  detail?: string,
): PlanDiagnostic {
  const d: PlanDiagnostic = { code, stage, repair, severity: "error", message };
  if (range !== null && line !== undefined && column !== undefined) {
    d.location = { startOffset: range.startOffset, endOffset: range.endOffset, line, column };
  }
  if (detail !== undefined) d.detail = detail;
  return d;
}

/** 1-based line/col → zero-based offset, via a lazily built line table. */
function offsetAt(html: string, lineIndex: number[], line: number, column: number): number {
  if (lineIndex.length === 0) {
    lineIndex.push(0);
    for (let i = 0; i < html.length; i += 1) {
      if (html.charCodeAt(i) === 10) lineIndex.push(i + 1);
    }
  }
  const base = lineIndex[line - 1];
  return base === undefined ? Math.min(html.length, Math.max(0, column - 1)) : base + column - 1;
}

/** The head/body/html elements the parser actually produced (or null). */
function findStructure(document: DefaultNode): PlanStructure {
  // Property writes defeat the closure-blind narrowing that would otherwise
  // read every element back as `null` after the visit.
  const found: { html: DefaultElement | null; head: DefaultElement | null; body: DefaultElement | null } = {
    html: null,
    head: null,
    body: null,
  };
  const visit = (node: DefaultNode): void => {
    if (found.html === null && isHtmlElement(node, "html")) found.html = node;
    if (found.head === null && isHtmlElement(node, "head")) found.head = node;
    if (found.body === null && isHtmlElement(node, "body")) found.body = node;
    for (const child of childNodesOf(node)) {
      if (!isElement(child)) continue;
      // Do not reach into foreign or inert content for document structure.
      if (child.namespaceURI !== HTML_NS || child.tagName === "template") continue;
      visit(child);
    }
  };
  visit(document);
  const headLoc = found.head?.sourceCodeLocation;
  const bodyLoc = found.body?.sourceCodeLocation;
  const htmlLoc = found.html?.sourceCodeLocation;
  return {
    closingHeadOffset:
      headLoc?.endTag && headLoc.endTag.startOffset >= 0 ? headLoc.endTag.startOffset : null,
    closingBodyOffset:
      bodyLoc?.endTag && bodyLoc.endTag.startOffset >= 0 ? bodyLoc.endTag.startOffset : null,
    afterHtmlOpen:
      htmlLoc?.startTag && htmlLoc.startTag.endOffset >= 0 ? htmlLoc.startTag.endOffset : null,
    hasExplicitHtml: Boolean(htmlLoc?.startTag && htmlLoc.startTag.startOffset >= 0),
    eofOffset: 0, // filled by the caller with the source length
  };
}

/**
 * Parse the authored document once: classified transformable blocks, decoded
 * sources, structural insertion points, and source-stage diagnostics.
 *
 * Diagnostic contract: parse5 syntax errors become `HTML_PARSE_ERROR`
 * (missing-doctype degrades to a warning); a transformable `pre`/`code`
 * missing its end tag, or containing element markup that should have been
 * escaped, becomes `CODE_MARKUP`. Nothing else about HTML style is judged —
 * optional end tags elsewhere, SVG bodies, and unknown languages pass.
 */
export function parsePlanSource(html: string): ParsedPlanSource {
  const diagnostics: PlanDiagnostic[] = [];
  const lineTable: number[] = [];

  const document = parse(html, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: false,
    onParseError: (error) => {
      const offset = offsetAt(html, lineTable, error.startLine, error.startCol);
      diagnostics.push({
        code: "HTML_PARSE_ERROR",
        stage: "source",
        repair: "source",
        severity: error.code === "missing-doctype" ? "warning" : "error",
        message: `HTML syntax: ${error.code}`,
        detail: `parser code ${error.code}`,
        location: {
          startOffset: offset,
          endOffset: Math.min(html.length, offset + 1),
          line: error.startLine,
          column: error.startCol,
        },
      });
    },
  });

  const codeBlocks: PlanCodeBlock[] = [];
  const diagramBlocks: PlanDiagramBlock[] = [];

  const noteUnclosed = (
    tagName: string,
    el: PlanElement,
    node: DefaultElement,
  ): void => {
    diagnostics.push(
      located(
        "CODE_MARKUP",
        "source",
        "source",
        `an unclosed <${tagName}> element leaves the document structure to parser recovery`,
        el.range,
        node.sourceCodeLocation?.startLine,
        node.sourceCodeLocation?.startCol,
      ),
    );
  };

  const noteMarkupInSource = (
    where: string,
    offender: DefaultElement,
  ): void => {
    diagnostics.push(
      located(
        "CODE_MARKUP",
        "source",
        "source",
        `block source contains element markup (${where}); escape literal < > & as HTML entities`,
        locate(offender),
        offender.sourceCodeLocation?.startLine,
        offender.sourceCodeLocation?.startCol,
        `<${offender.tagName}> inside the block`,
      ),
    );
  };

  const classifyPre = (pre: DefaultElement): void => {
    const preEl = elementOf(pre);
    if (preEl === null) return;
    if (!preEl.hasEndTag) {
      noteUnclosed("pre", preEl, pre);
      return; // recovery makes any inner range unreliable
    }
    // A real HTML `pre.mermaid` classifies as a diagram BEFORE languages.
    if (hasClassToken(preEl, "mermaid")) {
      const markup = elementDescendants(pre);
      if (markup.length > 0) {
        noteMarkupInSource('class="mermaid"', markup[0]!);
        return;
      }
      diagramBlocks.push({
        kind: "diagram",
        blockIndex: diagramBlocks.length,
        pre: preEl,
        sourceText: decodedText(pre),
      });
      return;
    }
    // Otherwise a code block: the single `code` element child, language from
    // the code (or, when it carries none, the pre).
    const codeChildren = childNodesOf(pre).filter((c) => isHtmlElement(c, "code"));
    if (codeChildren.length !== 1) return;
    const code = codeChildren[0] as DefaultElement;
    const codeEl = elementOf(code);
    if (codeEl === null) return;
    const lang = resolveLang(languageFrom(codeEl) ?? languageFrom(preEl));
    if (lang === null) return; // unknown language: plain, never guess
    if (!codeEl.hasEndTag) {
      noteUnclosed("code", codeEl, code);
      return;
    }
    const markup = elementDescendants(code);
    if (markup.length > 0) {
      noteMarkupInSource("code", markup[0]!);
      return;
    }
    const sourceText = decodedText(code);
    if (sourceText.length > HIGHLIGHT_CHAR_CAP) return; // over cap: plain, never a gate
    const codeLoc = code.sourceCodeLocation;
    if (!codeLoc || !codeLoc.startTag || codeLoc.startTag.startOffset < 0) {
      return;
    }
    const innerStart = codeLoc.startTag.endOffset;
    const innerEnd =
      codeLoc.endTag && codeLoc.endTag.startOffset >= 0
        ? codeLoc.endTag.startOffset
        : codeLoc.endOffset;
    codeBlocks.push({
      kind: "code",
      blockIndex: codeBlocks.length,
      pre: preEl,
      code: codeEl,
      lang,
      sourceText,
      inner: { startOffset: innerStart, endOffset: innerEnd },
    });
  };

  const visit = (node: DefaultNode): void => {
    for (const child of childNodesOf(node)) {
      if (!isElement(child)) continue;
      // Inert template content and foreign subtrees never define plan blocks.
      if (child.namespaceURI !== HTML_NS || child.tagName === "template") continue;
      if (child.tagName === "script" || child.tagName === "style" || child.tagName === "noscript") {
        continue;
      }
      if (child.tagName === "pre") classifyPre(child);
      visit(child);
    }
  };
  visit(document);

  const structure = findStructure(document);
  structure.eofOffset = html.length;

  return { html, diagnostics, codeBlocks, diagramBlocks, structure, document };
}

/**
 * Compose the prepared document: original slices interleaved with the
 * replacement strings, joined exactly once. Replacement semantics never
 * touch authored bytes — that is the whole defect class of issue #412.
 */
export function composePlanSource(html: string, replacements: PlanReplacement[]): string {
  const sorted = [...replacements].sort((a, b) => a.startOffset - b.startOffset);
  let out = "";
  let cursor = 0;
  for (const part of sorted) {
    if (part.startOffset < cursor) continue; // defensive: never rewind over source
    out += html.slice(cursor, part.startOffset);
    out += part.text;
    cursor = part.endOffset;
  }
  out += html.slice(cursor);
  return out;
}

/** An insertion at one offset (empty range). */
export function insertAt(offset: number, text: string): PlanReplacement {
  return { startOffset: offset, endOffset: offset, text };
}
