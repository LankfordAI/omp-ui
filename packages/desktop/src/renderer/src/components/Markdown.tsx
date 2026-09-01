import { useMemo, useState, type ReactNode } from "react";
import katex from "katex";
import { cn } from "../lib/cn";
import { useHighlightTokens } from "../lib/highlight";
import { useDiagramSvg } from "../lib/diagram";
import { bareUrlAt, isSafeHref, parseMarkdown, type MdBlock, type MdList, type MdSpan } from "../lib/markdown";
import { useT } from "../lib/i18n";
import { CopyButton } from "./ui";

/**
 * Renders parsed Markdown as React elements. There is deliberately no HTML
 * path — every node below is constructed, never interpreted, so untrusted
 * agent output cannot inject markup.
 */

/**
 * A real scale (issue #28): h1/h2 rise clearly above the 15px body, h3 holds
 * the body size in semibold, h4+ recede. The extra top margin (roughly double
 * the block gap) is what makes sections chunk; `first:mt-0` keeps a heading
 * that opens the answer flush.
 */
const HEADING_CLASS: Record<number, string> = {
  1: "text-xl mt-5 first:mt-0",
  2: "text-[17px] mt-4 first:mt-0",
  3: "text-[15px] mt-3 first:mt-0",
  4: "text-sm mt-3 first:mt-0",
  5: "text-sm mt-3 first:mt-0",
  6: "text-sm mt-3 first:mt-0",
};

const HEADING_TAG = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * KaTeX options (issue #191). `throwOnError: false` renders malformed TeX
 * visibly instead of failing the render item; `trust: false` blocks commands
 * that load resources or inject attributes (`\href`, `\url`,
 * `\includegraphics` …); `maxSize` and `maxExpand` bound size and
 * macro-expansion abuse; `htmlAndMathml` keeps the accessible MathML.
 */
const KATEX_OPTIONS = {
  output: "htmlAndMathml",
  throwOnError: false,
  strict: "ignore",
  trust: false,
  maxSize: 20,
  maxExpand: 1000,
} as const;

/**
 * Rendered-string cache keyed by (display, text): streaming re-renders the
 * same expression without re-running KaTeX, and identical formulas in
 * different render items share one result.
 */
const mathHtmlCache = new Map<string, string>();

function renderMathHtml(text: string, display: boolean): string {
  const key = `${display ? 1 : 0}\u0000${text}`;
  let html = mathHtmlCache.get(key);
  if (html === undefined) {
    html = katex.renderToString(text, { ...KATEX_OPTIONS, displayMode: display });
    mathHtmlCache.set(key, html);
  }
  return html;
}

/**
 * One KaTeX expression. The sole HTML insertion in this file: the markup
 * comes from `katex.renderToString` on the TeX payload the parser extracted
 * — never on source text or arbitrary Markdown — and KaTeX's `trust: false`
 * keeps that markup free of resource loads and injected attributes.
 * Display output is a full-width div; its scroll container (and the streaming
 * caret, which rides after the formula, outside KaTeX-owned markup) is
 * composed by `Block` so this interface stays exactly `{ text, display }`.
 */
function MathExpression({ text, display }: { text: string; display: boolean }): ReactNode {
  const html = useMemo(() => renderMathHtml(text, display), [text, display]);
  if (display) {
    return <div className="w-full" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <span className="md-math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * One external link anchor: no `href` attribute (renderer never navigates; the
 * absence also kills middle-click/drag), clicks route window.open — intercepted
 * by main's setWindowOpenHandler → shell.openExternal (issue #101).
 */
function OpenExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      role="link"
      tabIndex={0}
      title={href}
      onClick={() => window.open(href, "_blank", "noopener,noreferrer")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
      className="cursor-pointer text-iris underline decoration-iris-dim underline-offset-2 hover:decoration-iris"
    >
      {children}
    </a>
  );
}

function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case "code":
            return (
              <code key={i} className="rounded bg-overlay px-1 font-mono text-[0.9em] text-ink">
                {span.text}
              </code>
            );
          case "math":
            return (
              <MathExpression key={i} text={span.text} display={false} />
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold text-ink">
                <Spans spans={span.spans} />
              </strong>
            );
          case "em":
            return (
              <em key={i} className="italic">
                <Spans spans={span.spans} />
              </em>
            );
          case "link":
            return isSafeHref(span.href) ? (
              <OpenExternalLink key={i} href={span.href}>
                <Spans spans={span.spans} />
              </OpenExternalLink>
            ) : (
              // A rejected scheme becomes plain text with no tooltip: echoing
              // the target back would still put `javascript:…` on screen as if
              // it were a real destination.
              <span key={i}>
                <Spans spans={span.spans} />
              </span>
            );
          default:
            return <span key={i}>{span.text}</span>;
        }
      })}
    </>
  );
}

/**
 * Bare-URL autolink for plain-text surfaces (tool slabs, issue #101). Because
 * `bareUrlAt` only ever emits `http(s)://` targets, no `isSafeHref` gate is
 * needed here.
 */
export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const url = c === "h" || c === "H" ? bareUrlAt(text, i) : null;
    if (url === null) {
      i++;
      continue;
    }
    if (i > cursor) out.push(text.slice(cursor, i)); // plain text before the URL
    out.push(
      <OpenExternalLink key={i} href={url.href}>
        {url.href}
      </OpenExternalLink>,
    );
    cursor = url.next;
    i = url.next;
  }
  if (cursor < text.length) out.push(text.slice(cursor)); // tail incl. trimmed punctuation
  return out;
}

/**
 * Prose blocks cap at ~70ch (issue #26): past that, long lines cost more eye
 * travel than they save in height. Code, tables, and rules deliberately keep
 * the full column — they earn their width. The cap lives per-block rather
 * than on the container so both can be true at once.
 */
const MEASURE = "max-w-[70ch]";

/**
 * One list block, recursing into nested child lists. Markers are manual
 * (`1.` / `•`) rather than `<ol>` counters, so numbering is the item's
 * position in its own list and can never restart mid-stream. Item content is
 * rendered as blocks (paragraphs and fenced code, issue #41) through `Block`.
 * The streaming caret rides the deepest last item — recursed into the final
 * child list when the last item has children, else riding the last block of
 * its final item.
 */
function ListBlock({ list, trailing }: { list: MdList; trailing?: ReactNode }) {
  return (
    <ul className={cn("space-y-1", MEASURE)}>
      {list.items.map((item, i) => {
        const last = i === list.items.length - 1;
        const hasChildren = item.children.length > 0;
        return (
          <li key={i} className="flex gap-2">
            <span
              className={cn(
                "shrink-0 select-none text-ink-dim",
                list.ordered ? "min-w-[1.4em] text-right tabular-nums" : "min-w-[1em]",
              )}
            >
              {list.ordered ? `${i + 1}.` : "•"}
            </span>
            <div className="min-w-0 flex-1 leading-[1.7]">
              {item.blocks.map((block, k) => (
                <Block
                  key={k}
                  block={block}
                  trailing={
                    !hasChildren && last && k === item.blocks.length - 1 ? trailing : undefined
                  }
                />
              ))}
              {hasChildren ? (
                <div className="mt-1 space-y-2">
                  {item.children.map((child, k) => (
                    <ListBlock
                      key={k}
                      list={child}
                      trailing={last && k === item.children.length - 1 ? trailing : undefined}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CodeBlock({
  text,
  lang,
  trailing,
}: {
  text: string;
  lang: string | null;
  trailing?: ReactNode;
}) {
  const isDiagram = lang?.toLowerCase() === "mermaid";
  const settled = trailing === undefined;
  // The diagram hook is called unconditionally (hook rules); `enabled` gates
  // the work, exactly like the `enabled` flag on useHighlightTokens. mermaid
  // has no shiki grammar, so pass no language and the pre stays plain.
  const svg = useDiagramSvg(text, isDiagram && settled);
  const tokens = useHighlightTokens(text, isDiagram ? undefined : (lang ?? undefined), settled);
  const t = useT();
  const [showSource, setShowSource] = useState(false);
  const asDiagram = isDiagram && svg !== null && !showSource;
  return (
    <div className="overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex items-center justify-between border-b border-line-soft px-2 py-0.5">
        <span className="font-mono text-[10px] lowercase text-ink-dim">{lang ?? "text"}</span>
        <span className="flex items-center gap-1">
          {isDiagram && svg !== null && (
            <button
              type="button"
              onClick={() => setShowSource((s) => !s)}
              className="font-mono text-[10px] text-ink-dim transition-colors duration-150 hover:text-ink"
            >
              {asDiagram ? t("markdown.codeblock.source") : t("markdown.codeblock.diagram")}
            </button>
          )}
          <CopyButton
            text={text}
            label={t("common.button.copy")}
            doneLabel={t("common.button.copied")}
          />
        </span>
      </div>
      {asDiagram ? (
        // The sole HTML insertion for agent prose beyond KaTeX: `svg` is
        // mermaid strict-mode sanitizer output (issue #285's posture), never
        // source text. Scrolls/centers per .md-diagram in style.css.
        <div
          className="md-diagram"
          role="img"
          aria-label={t("markdown.diagram.aria")}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre
          data-selectable
          className="overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-[1.6] text-ink"
        >
          {tokens
            ? tokens.map((line, i) => (
                <span key={i}>
                  {line.map((token, k) => (
                    <span key={k} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
                  {i < tokens.length - 1 ? "\n" : null}
                </span>
              ))
            : text}
          {trailing}
        </pre>
      )}
    </div>
  );
}

/** `trailing` is the streaming caret; it rides the last block so it never orphans. */
function Block({ block, trailing }: { block: MdBlock; trailing?: ReactNode }) {
  switch (block.kind) {
    case "code":
      return <CodeBlock text={block.text} lang={block.lang} trailing={trailing} />;

    case "math":
      // Display math earns its column width (like tables): the wrapper is the
      // local horizontal scroll region, so a wide formula scrolls inside the
      // transcript width instead of widening it. The caret rides after the
      // formula, never inside KaTeX-owned markup.
      return (
        <div className="md-math-display overflow-x-auto">
          <MathExpression text={block.text} display />
          {trailing}
        </div>
      );

    case "heading": {
      // Real heading tags: assistant answers are documents, and AT users
      // navigate them by outline rather than by scrolling.
      const Tag = HEADING_TAG[Math.min(Math.max(block.level, 1), 6) - 1] ?? "h3";
      return (
        <Tag
          className={cn(
            "font-display font-semibold text-ink",
            MEASURE,
            HEADING_CLASS[block.level] ?? "text-sm",
            block.level >= 4 && "text-ink-mid",
          )}
        >
          <Spans spans={block.spans} />
          {trailing}
        </Tag>
      );
    }

    case "list":
      return <ListBlock list={block} trailing={trailing} />;

    case "quote":
      return (
        <blockquote className={cn("border-l-2 border-line-strong pl-3 text-ink", MEASURE)}>
          <p className="whitespace-pre-wrap break-words leading-[1.7]">
            <Spans spans={block.spans} />
            {trailing}
          </p>
        </blockquote>
      );

    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {block.headers.map((cell, i) => (
                  <th
                    key={i}
                    className="border-b-2 border-line-strong px-2 py-1.5 text-left font-semibold text-ink"
                  >
                    <Spans spans={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="border-b border-line px-2 py-1.5 text-ink">
                      <Spans spans={cell} />
                      {ri === block.rows.length - 1 &&
                        ci === row.length - 1 &&
                        trailing}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "rule":
      return (
        <div>
          <hr className="h-px border-0 bg-line" />
          {trailing}
        </div>
      );

    default:
      return (
        <p className={cn("whitespace-pre-wrap break-words leading-[1.7]", MEASURE)}>
          <Spans spans={block.spans} />
          {trailing}
        </p>
      );
  }
}

export function Markdown({
  text,
  className,
  trailing,
}: {
  text: string;
  className?: string;
  /** Appended inside the final block — used for the streaming caret. */
  trailing?: ReactNode;
}) {
  // Streaming re-renders this on every delta, and the parse is the cost.
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return trailing ? <div className={className}>{trailing}</div> : null;
  return (
    <div className={cn("space-y-3 text-[15px]", className)} data-selectable>
      {blocks.map((block, i) => (
        <Block key={i} block={block} trailing={i === blocks.length - 1 ? trailing : undefined} />
      ))}
    </div>
  );
}
