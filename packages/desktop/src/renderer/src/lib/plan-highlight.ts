/**
 * Syntax highlighting for HTML plan code blocks (issue #319, ADR-0023,
 * reworked for the source-range pipeline of the issue #312 follow-up).
 *
 * The ADR-0020 posture for code is unchanged: the agent authors source in a
 * language-classed `<code>` element, the renderer tokenizes in the trusted
 * process at review time, and the sandboxed iframe receives only inert spans.
 * Plain text is the fallback for anything that cannot be tokenized — no
 * callout, because the text is the content (unlike mermaid, whose SVG is the
 * content).
 *
 * What changed: there is no placeholder protocol any more. Blocks come from
 * `parsePlanSource` with original source ranges; the output is a list of
 * splice operations the composer joins once, so an authored `$'`, `$&`, or
 * backtick-dollar inside code text can never act as a replacement pattern
 * (issue #412), and an authored marker-looking comment is just source.
 */
import type { ThemedToken } from "shiki/core";
import { tokenizeCode } from "./highlight";
import { escapeHtml } from "./plan-diagrams";
import type {
  ParsedPlanSource,
  PlanElement,
  PlanReplacement,
} from "./plan-source";
import type { Theme } from "./themes";

/** Tokenizer seam; `null` leaves the block plain. */
export type CodeTokenizer = (
  source: string,
  lang: string,
  theme: Theme,
) => Promise<ThemedToken[][] | null>;

export interface HighlightTransform {
  /** Splices into the composed document; empty when nothing highlighted. */
  replacements: PlanReplacement[];
  /** Token-class rules for the pairs used; `""` when nothing highlighted. */
  tokenCss: string;
}

const LANGUAGE_CLASS = /^language-[\w+#-]+$/i;

/** The pair key separator: a byte that can appear in neither a color nor a number. */
const PAIR_SEP = String.fromCharCode(0);

/** `\r\n`/`\r` → `\n`; the comparison normalizer for parsed vs token text. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

interface TokenPair {
  idx: number;
  color: string | null;
  /** shiki's fontStyle bitmask: 1 italic, 2 bold, 4 underline. */
  fontStyle: number;
}

/**
 * Replaces every classified code block that tokenizes cleanly with a
 * highlighted re-emission: per-token `<span class="tk-N">` spans plus one
 * color/style rule per (color, fontStyle) pair used anywhere in the document.
 *
 * Each accepted block yields surgical splices — the class attribute bytes,
 * and the code element's inner range — so every other byte of the block and
 * the whole untouched document survive the composition literally. A block
 * whose tokenizer rejects, returns `null`, or whose token stream fails to
 * reconstruct the decoded source keeps its original bytes; siblings are
 * unaffected. The `language-*` token is consumed from the class. Highlighting
 * stays a successful, content-preserving fallback: a grammar that fails to
 * load never blocks anything (the input contract is authored source only —
 * prepared output is never re-prepared).
 */
export async function planHighlightTransform(
  parsed: ParsedPlanSource,
  theme: Theme,
  tokenize: CodeTokenizer = tokenizeWithShiki,
): Promise<HighlightTransform> {
  const pairs = new Map<string, TokenPair>();
  const replacements: PlanReplacement[] = [];
  for (const block of parsed.codeBlocks) {
    let lines: ThemedToken[][] | null = null;
    try {
      lines = await tokenize(block.sourceText, block.lang, theme);
    } catch {
      // Failed grammar/engine load: the block stays plain. Highlighting is
      // an enhancement, never a gate.
      continue;
    }
    if (lines === null) continue;
    // Reconstruction check before accepting the token stream: the spans must
    // carry exactly the decoded source back, or the block stays plain.
    // Newline handling is normalized on both sides (HTML parsers deliver \n;
    // shiki reports token lines joined with \n).
    const reconstructed = lines.map((line) => line.map((t) => t.content).join("")).join("\n");
    if (normalizeNewlines(reconstructed) !== normalizeNewlines(block.sourceText)) {
      continue;
    }
    replacements.push({
      startOffset: block.inner.startOffset,
      endOffset: block.inner.endOffset,
      text: serializeLines(lines, pairs),
    });
    replacements.push(
      ...classAttrSplices(parsed.html, block.pre, { consumeLanguage: true, addClass: "omp-ui-hl" }),
      ...classAttrSplices(parsed.html, block.code, { consumeLanguage: true }),
    );
  }
  return { replacements, tokenCss: tokenCss(pairs) };
}

/**
 * `fontStyle` is shiki's bitmask (1 italic, 2 bold, 4 underline). A token
 * with no theme color and no style is emitted bare — no class, no span — so
 * common tokens keep the DOM light. (color, fontStyle) pairs dedupe across
 * the whole document into the shared `pairs` map.
 */
function serializeLines(
  lines: ThemedToken[][],
  pairs: Map<string, TokenPair>,
): string {
  return lines
    .map((line) =>
      line
        .map((t) => {
          const color = t.color ?? null;
          const fontStyle = t.fontStyle ?? 0;
          if (color === null && fontStyle === 0) return escapeHtml(t.content);
          const key = `${color ?? ""}${PAIR_SEP}${fontStyle}`;
          let entry = pairs.get(key);
          if (!entry) {
            entry = { idx: pairs.size, color, fontStyle };
            pairs.set(key, entry);
          }
          return `<span class="tk-${entry.idx}">${escapeHtml(t.content)}</span>`;
        })
        .join(""),
    )
    .join("\n");
}

/**
 * One rule per (color, fontStyle) pair used anywhere in the document. The
 * class rule beats the universal `color: inherit !important` in the same
 * stylesheet by specificity (0-2-0 vs 0-0-1) at equal important tier, so it
 * holds even in a parser that drops the `:not(svg, svg *)` negation
 * (ADR-0020's carve-out pattern).
 */
function tokenCss(pairs: Map<string, TokenPair>): string {
  if (pairs.size === 0) return "";
  const rules = [...pairs.values()]
    .sort((a, b) => a.idx - b.idx)
    .map((p) => {
      const props: string[] = [];
      if (p.color) props.push(`color: ${p.color} !important`);
      if (p.fontStyle & 1) props.push("font-style: italic");
      if (p.fontStyle & 2) props.push("font-weight: 600");
      if (p.fontStyle & 4) props.push("text-decoration: underline");
      return `.omp-ui-hl .tk-${p.idx} { ${props.join("; ")}; }`;
    });
  return `\n/* Renderer-generated token colours (issue #319): inert spans from
     the prepare pass; specificity beats the universal colour rule above. */\n` +
    rules.join("\n");
}

const tokenizeWithShiki: CodeTokenizer = async (source, lang, theme) => {
  try {
    return await tokenizeCode(lang, source, theme);
  } catch {
    return null;
  }
};

/**
 * Splices that consume the `language-*` token (the convention is consumed,
 * not rewritten elsewhere) and add `addClass` — applied to the class
 * attribute's OWN source range so every other byte of the tag passes through
 * untouched. When the element has no class attribute, the addition inserts
 * before the start tag's `>`; nothing is consumed.
 */
function classAttrSplices(
  html: string,
  el: PlanElement,
  opts: { consumeLanguage: boolean; addClass?: string },
): PlanReplacement[] {
  const attr = el.attrs.find((a) => a.name === "class");
  if (attr === undefined || attr.range === null) {
    if (opts.addClass === undefined || el.startTag === null) return [];
    return [
      {
        startOffset: el.startTag.endOffset - 1,
        endOffset: el.startTag.endOffset - 1,
        text: ` class="${opts.addClass}"`,
      },
    ];
  }
  const raw = html.slice(attr.range.startOffset, attr.range.endOffset);
  const eq = raw.indexOf("=");
  const tokens =
    eq === -1
      ? []
      : raw
          .slice(eq + 1)
          .replace(/^['"]|['"]$/g, "")
          .split(/\s+/)
          .filter(Boolean);
  const kept = opts.consumeLanguage ? tokens.filter((t) => !LANGUAGE_CLASS.test(t)) : tokens;
  if (opts.addClass && !kept.includes(opts.addClass)) kept.push(opts.addClass);
  const quote = raw.includes("'") ? "'" : '"';
  const replacement = kept.length > 0 ? `class=${quote}${kept.join(" ")}${quote}` : "";
  if (replacement === raw) return [];
  if (replacement === "") {
    // Swallow the whitespace preceding the attribute so removal leaves no
    // stray gap; every other byte of the tag is preserved by the composition.
    let from = attr.range.startOffset;
    while (from > 0 && /\s/.test(html.charAt(from - 1))) from -= 1;
    return [{ startOffset: from, endOffset: attr.range.endOffset, text: "" }];
  }
  return [{ startOffset: attr.range.startOffset, endOffset: attr.range.endOffset, text: replacement }];
}
