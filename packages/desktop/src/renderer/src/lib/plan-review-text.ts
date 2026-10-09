import { parseMarkdown, type MdBlock, type MdListItem, type MdSpan } from "./markdown";
import {
  childNodesOf,
  HTML_NS,
  MATH_ML_NS,
  parsePlanSource,
  SVG_NS,
  type DefaultElement,
  type DefaultNode,
  type DefaultTextNode,
} from "./plan-source";

const OMITTED_ELEMENTS: Record<string, true> = {
  head: true, script: true, style: true, template: true, noscript: true,
};
const PROSE_BLOCKS: Record<string, true> = {
  address: true, article: true, aside: true, blockquote: true, dd: true, div: true,
  dl: true, dt: true, fieldset: true, figcaption: true, figure: true, footer: true,
  header: true, main: true, nav: true, p: true, section: true, summary: true,
};

function element(node: DefaultNode): DefaultElement | null {
  return "tagName" in node ? node : null;
}

function attr(node: DefaultElement, name: string): string | undefined {
  return node.attrs.find((value) => value.name === name)?.value;
}

function omitted(node: DefaultElement): boolean {
  return OMITTED_ELEMENTS[node.tagName.toLowerCase()] === true ||
    attr(node, "hidden") !== undefined || attr(node, "aria-hidden")?.toLowerCase() === "true";
}

function classTokens(node: DefaultElement): string[] {
  return (attr(node, "class") ?? "").split(/[\t\n\f\r ]+/).filter(Boolean);
}

/** Text from the parsed tree is already decoded. Never decode it a second time. */
function rawText(node: DefaultNode, math = false): string {
  if (node.nodeName === "#text") return (node as DefaultTextNode).value;
  const el = element(node);
  if (el && (omitted(el) || (el.namespaceURI === SVG_NS &&
    (el.tagName === "defs" || el.tagName === "metadata")) || (math &&
    (el.tagName === "annotation" || el.tagName === "annotation-xml")))) return "";
  let text = "";
  for (const child of childNodesOf(node)) text += rawText(child, math);
  return text;
}

function codeBlock(text: string, lang: string | null, diagram = false): string {
  const label = diagram ? "Diagram source (Mermaid)" : lang ? `Code (${lang})` : "Code";
  return `[${label}]\n${text}\n[/${diagram ? "Diagram source" : "Code"}]`;
}

/** Normalization applies only to prose; raw blocks never pass through it. */
function htmlLines(root: DefaultNode, labelsOnly = false): string[] {
  const lines: string[] = [];
  let pending = "";
  let prefix = "";
  const boundary = (): void => {
    const content = pending.replace(/[\t\n\f\r ]+/g, " ").trim();
    const text = content === "" ? "" : prefix + content;
    if (content !== "") prefix = "";
    if (text !== "") {
      if (lines.at(-1) === "") lines[lines.length - 1] = text;
      else lines.push(text);
    }
    pending = "";
  };
  const block = (text: string): void => {
    boundary();
    if (text !== "") {
      const content = prefix + text;
      prefix = "";
      if (lines.at(-1) === "") lines[lines.length - 1] = content;
      else lines.push(content);
    }
  };

  const table = (node: DefaultElement): void => {
    boundary();
    const rows = (parent: DefaultNode): void => {
      for (const child of childNodesOf(parent)) {
        const el = element(child);
        if (!el || omitted(el) || el.namespaceURI !== HTML_NS) continue;
        if (el.tagName === "caption") {
          block(htmlLines(el, labelsOnly).join("\n"));
        } else if (el.tagName === "tr") {
          const cells = childNodesOf(el).filter((cell) => {
            const cellEl = element(cell);
            return cellEl && !omitted(cellEl) && cellEl.namespaceURI === HTML_NS &&
              (cellEl.tagName === "th" || cellEl.tagName === "td");
          });
          if (cells.length > 0) block(cells.map((cell) => htmlLines(cell, labelsOnly).join("\n")).join(" | "));
        } else if (el.tagName === "thead" || el.tagName === "tbody" || el.tagName === "tfoot") {
          rows(el);
        }
      }
    };
    rows(node);
  };

  const svg = (node: DefaultElement): void => {
    boundary();
    const seen = new Set<string>();
    const label = (text: string, normalize = true): void => {
      const normalized = normalize ? text.replace(/[\t\n\f\r ]+/g, " ").trim() : text;
      if (normalized === "" || seen.has(normalized)) return;
      seen.add(normalized);
      block(normalized);
    };
    const labels = (parent: DefaultNode): void => {
      const el = element(parent);
      if (!el || omitted(el)) return;
      if (el.namespaceURI !== SVG_NS) return;
      if (el.tagName === "defs" || el.tagName === "metadata") return;
      if (el.tagName === "text" || el.tagName === "tspan" ||
        el.tagName === "title" || el.tagName === "desc") {
        // A text parent owns its tspans. Descending again would repeat them.
        label(rawText(el));
        return;
      }
      if (el.tagName === "foreignObject") {
        for (const child of childNodesOf(el)) {
          if (child.nodeName === "#text") label((child as DefaultTextNode).value);
          else if (element(child)?.namespaceURI === HTML_NS) {
            for (const text of htmlLines(child, true)) label(text, false);
          }
        }
        return;
      }
      for (const child of childNodesOf(el)) labels(child);
    };
    labels(node);
  };

  const list = (node: DefaultElement): void => {
    boundary();
    if (prefix !== "") {
      lines.push(prefix.trim());
      prefix = "";
    }
    const ordered = node.tagName === "ol";
    const start = Number(attr(node, "start") ?? 1);
    let ordinal = Number.isInteger(start) ? start : 1;
    for (const child of childNodesOf(node)) {
      const item = element(child);
      if (!item || omitted(item)) continue;
      if (item.namespaceURI === HTML_NS && item.tagName === "li") {
        const value = Number(attr(item, "value") ?? ordinal);
        if (Number.isInteger(value)) ordinal = value;
        boundary();
        if (!labelsOnly) prefix = ordered ? `${ordinal}. ` : "- ";
        for (const content of childNodesOf(item)) visit(content);
        boundary();
        if (prefix !== "") {
          lines.push(prefix.trim());
          prefix = "";
        }
        ordinal++;
      } else {
        visit(child);
      }
    }
  };

  const visit = (node: DefaultNode): void => {
    if (node.nodeName === "#text") {
      pending += (node as DefaultTextNode).value;
      return;
    }
    const el = element(node);
    if (!el) {
      for (const child of childNodesOf(node)) visit(child);
      return;
    }
    if (omitted(el)) return;
    if (el.namespaceURI === SVG_NS) {
      svg(el);
      return;
    }
    if (el.namespaceURI === MATH_ML_NS) {
      if (el.tagName === "annotation" || el.tagName === "annotation-xml") return;
      const display = attr(el, "display") === "block";
      if (display) boundary();
      pending += rawText(el, true);
      if (display) boundary();
      return;
    }
    if (el.namespaceURI !== HTML_NS) return;
    if (el.tagName === "pre" || el.tagName === "code") {
      const code = childNodesOf(el).map(element).find((child) =>
        child?.namespaceURI === HTML_NS && child.tagName === "code");
      const language = (code ? classTokens(code) : []).find((token) => token.startsWith("language-")) ??
        classTokens(el).find((token) => token.startsWith("language-"));
      block(codeBlock(rawText(el), language?.slice("language-".length) || null,
        el.tagName === "pre" && classTokens(el).includes("mermaid")));
      return;
    }
    if (el.tagName === "table") {
      table(el);
      return;
    }
    if (el.tagName === "ul" || el.tagName === "ol") {
      list(el);
      return;
    }
    if (el.tagName === "br") {
      boundary();
      if (lines.length === 0) lines.push("");
      lines.push("");
      return;
    }
    if (el.tagName === "hr") {
      block("---");
      return;
    }
    const heading = /^h[1-6]$/.test(el.tagName);
    const isBlock = heading || PROSE_BLOCKS[el.tagName] === true || el.tagName === "li";
    if (isBlock) boundary();
    if (heading && !labelsOnly) pending += `${"#".repeat(Number(el.tagName[1]))} `;
    if (el.tagName === "li" && !labelsOnly) prefix = "- ";
    for (const child of childNodesOf(el)) visit(child);
    if (isBlock) boundary();
  };

  visit(root);
  boundary();
  return lines;
}

function markdownSpans(spans: readonly MdSpan[]): string {
  return spans.map((span) => {
    switch (span.kind) {
      case "em":
      case "strong":
      case "link":
        return markdownSpans(span.spans);
      case "code":
        return `\`${span.text}\``;
      case "math":
        return `$${span.text}$`;
      default:
        return span.text;
    }
  }).join("");
}

function markdownItems(items: readonly MdListItem[], ordered: boolean, depth: number): string {
  return items.map((item, index) => {
    const indent = "  ".repeat(depth);
    const content = markdownBlocks(item.blocks, depth);
    const children = item.children.map((child) => markdownItems(child.items, child.ordered, depth + 1));
    return `${indent}${ordered ? `${index + 1}.` : "-"} ${content}` +
      (children.length > 0 ? `\n${children.join("\n")}` : "");
  }).join("\n");
}

function markdownBlocks(blocks: readonly MdBlock[], depth = 0): string {
  return blocks.map((block) => {
    switch (block.kind) {
      case "p":
        return markdownSpans(block.spans);
      case "heading":
        return `${"#".repeat(block.level)} ${markdownSpans(block.spans)}`;
      case "quote":
        return markdownSpans(block.spans).split("\n").map((line) => `> ${line}`).join("\n");
      case "list":
        return markdownItems(block.items, block.ordered, depth);
      case "code":
        return codeBlock(block.text, block.lang, block.lang?.toLowerCase() === "mermaid");
      case "math":
        return `[Math]\n${block.text}\n[/Math]`;
      case "table":
        return [block.headers, ...block.rows]
          .map((row) => row.map(markdownSpans).join(" | ")).join("\n");
      case "rule":
        return "---";
    }
  }).join("\n\n");
}

/** Complete authored artifact projection; no character budget or source rewrite. */
export function planReviewText(source: string, format: "html" | "markdown"): string {
  return format === "html"
    ? htmlLines(parsePlanSource(source).document).join("\n")
    : markdownBlocks(parseMarkdown(source));
}
