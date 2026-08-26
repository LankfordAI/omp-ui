/**
 * Syntax highlighting for HTML plan code blocks (issue #319, ADR-0023).
 *
 * The ADR-0020 posture for code: the agent authors source in a language-
 * classed `<code>` element, the renderer tokenizes in the trusted process at
 * review time, and the sandboxed iframe receives only inert spans. Plain
 * text is the fallback for anything that cannot be tokenized — no callout,
 * because the text is the content (unlike mermaid, whose SVG is the content).
 *
 * Kept separate from plan-document.ts so the transform stays unit-testable
 * with an injected stub tokenizer (the same seam as plan-diagrams.ts).
 */
import type { ThemedToken } from "shiki/core";
import { HIGHLIGHT_CHAR_CAP, resolveLang, tokenizeCode } from "./highlight";
import { decodeEntities, escapeHtml } from "./plan-diagrams";
import type { Theme } from "./themes";

/** Tokenizer seam; `null` leaves the block plain. */
export type CodeTokenizer = (
  source: string,
  lang: string,
  theme: Theme,
) => Promise<ThemedToken[][] | null>;

export interface CodeBlock {
  /** Unique inert placeholder substituted into the document string. */
  placeholder: string;
  /** Full matched `<pre>…</pre>` block, re-emitted verbatim when the block stays plain. */
  pre: string;
  /** `<pre>` attribute string (class lookup + re-emission). */
  preAttrs: string;
  /** `<code>` attribute string (class lookup + re-emission). */
  codeAttrs: string;
  /** Canonical grammar name. */
  lang: string;
  /** HTML-entity-decoded code text. */
  source: string;
}

export interface HighlightOutcome {
  html: string;
  /** Token-class rules for the pairs used; `""` when nothing was highlighted. */
  tokenCss: string;
}

// A plan code block cannot contain a literal `</code>` or `</pre>`: the
// authoring contract escapes < > & (the same assumption MERMAID_BLOCK relies
// on). The class match is a token match so `class="language-python fancy"`
// still counts.
const PRE_BLOCK = /<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi;
const CODE_ELEMENT = /<code\b([^>]*)>([\s\S]*?)<\/code\s*>/i;
const BLOCK_PLACEHOLDER = (n: number) => `<!--omp-ui-highlight-${n}-->`;

/** Consumed by verifyPlanStructure (parity with the diagram-placeholder check). */
export const HIGHLIGHT_PLACEHOLDER = /<!--omp-ui-highlight-\d+-->/;

const LANGUAGE_CLASS = /^language-[\w+#-]+$/i;

function languageFrom(attrs: string): string | null {
  const cls = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const value = cls?.[1] ?? cls?.[2] ?? "";
  const token = value.split(/\s+/).find((t) => LANGUAGE_CLASS.test(t));
  return token ? token.slice("language-".length) : null;
}

/**
 * Finds every `<pre>…<code>…</code>…</pre>` block whose `<code>` (or, when the
 * code carries none, the `<pre>`) is language-classed, resolves the language,
 * and replaces the block in `html` with a unique inert HTML-comment
 * placeholder. Blocks without a `<code>` child, without a recognized
 * language, or over the character cap stay in place, untouched.
 */
export function extractCodeBlocks(
  html: string,
): { html: string; blocks: CodeBlock[] } {
  const blocks: CodeBlock[] = [];
  const out = html.replace(PRE_BLOCK, (match, preAttrs: string, inner: string) => {
    const code = CODE_ELEMENT.exec(inner);
    if (!code) return match; // bare <pre> without a <code> child stays plain
    const lang = languageFrom(code[1]) ?? languageFrom(preAttrs);
    const resolved = resolveLang(lang);
    if (!resolved) return match; // unknown language: plain, never guess
    const source = decodeEntities(code[2]);
    if (source.length > HIGHLIGHT_CHAR_CAP) return match;
    const placeholder = BLOCK_PLACEHOLDER(blocks.length);
    blocks.push({
      placeholder,
      pre: match,
      preAttrs,
      codeAttrs: code[1],
      lang: resolved,
      source,
    });
    return placeholder;
  });
  return { html: out, blocks };
}

interface TokenPair {
  idx: number;
  color: string | null;
  /** shiki's fontStyle bitmask: 1 italic, 2 bold, 4 underline. */
  fontStyle: number;
}

/**
 * Replaces every language-classed code block in `html` with a highlighted
 * re-emission: `<pre class="omp-ui-hl"><code>` wrapping inert per-token
 * `<span class="tk-N">` spans, plus one color/style rule per (color,
 * fontStyle) pair used anywhere in the document. A block whose tokenizer
 * rejects (or returns `null`) is re-emitted verbatim; siblings are
 * unaffected.
 *
 * Idempotent by consumption: `rebuildAttrs` drops the `language-*` token, so
 * a second prepare pass over the output finds no language classes and returns
 * the bytes unchanged.
 */
export async function highlightCodeBlocks(
  html: string,
  theme: Theme,
  tokenize: CodeTokenizer = tokenizeWithShiki,
): Promise<HighlightOutcome> {
  const { html: staged, blocks } = extractCodeBlocks(html);
  const pairs = new Map<string, TokenPair>();
  let out = staged;
  for (const block of blocks) {
    let highlighted: string | null = null;
    try {
      const lines = await tokenize(block.source, block.lang, theme);
      if (lines) {
        const spans = serializeLines(lines, pairs);
        highlighted =
          `<pre${rebuildAttrs(block.preAttrs, true, "omp-ui-hl")}>` +
          `<code${rebuildAttrs(block.codeAttrs, true)}>` +
          `${spans}</code></pre>`;
      }
    } catch {
      // Failed grammar/engine load: the block stays plain.
    }
    // The placeholder is a unique comment token by construction, so a plain
    // string replace cannot collide with authored content.
    out = out.replace(block.placeholder, highlighted ?? block.pre);
  }
  return { html: out, tokenCss: tokenCss(pairs) };
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
          const key = `${color ?? ""}\u0000${fontStyle}`;
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
 * Drops the `language-*` token from the class attribute (consuming the
 * convention, which is what makes a second prepare pass a no-op) and adds
 * `addClass` where asked. Other attributes pass through byte-for-byte.
 */
function rebuildAttrs(attrs: string, consumeLanguage: boolean, addClass?: string): string {
  const cls = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (!cls) return addClass ? `${attrs} class="${addClass}"` : attrs;
  const quote = cls[1] !== undefined ? '"' : "'";
  let value = (cls[1] ?? cls[2] ?? "").split(/\s+/).filter(Boolean);
  if (consumeLanguage) value = value.filter((t) => !LANGUAGE_CLASS.test(t));
  if (addClass && !value.includes(addClass)) value.push(addClass);
  const next = value.length ? ` class=${quote}${value.join(" ")}${quote}` : "";
  // Swap the attribute (and the whitespace preceding it) so an emptied class
  // leaves no stray space in the tag; every other byte of the attributes is
  // preserved.
  const at = cls.index!;
  let from = at;
  while (from > 0 && /\s/.test(attrs.charAt(from - 1))) from -= 1;
  return attrs.slice(0, from) + next + attrs.slice(at + cls[0].length);
}
