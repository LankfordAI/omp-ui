import { useEffect, useState } from "react";
import { renderMermaid } from "./plan-diagrams";
import { useTheme } from "./themes";

/**
 * SVG for a settled mermaid source, or null (streaming, in flight, failed —
 * the caller keeps showing the code block). Transcript counterpart of
 * renderMermaidBlocks for HTML plans (issue #285, extended to the transcript by
 * issue #361): mermaid runs in the trusted renderer with securityLevel
 * "strict"; the returned SVG is sanitizer output, inserted like KaTeX markup
 * in Markdown.tsx.
 */

/** Rendered-SVG cache keyed (dark, source): the transcript re-renders its
 *  items often (streaming commits, theme switches, pane remounts) and one
 *  mermaid render costs ~100 ms. In-flight promises dedupe identical sources
 *  rendered by sibling blocks. LRU-capped: transcripts are long. */
const CACHE_CAP = 64;
const cache = new Map<string, Promise<string>>();

/** Distinct from the plan path's `omp-ui-diagram-N` (per-document numbering
 *  would collide across transcript items sharing one DOM). */
let blockSeq = 0;

function diagramSvg(source: string, dark: boolean): Promise<string> {
  // NUL sentinel separator (mathHtmlCache's pattern, Markdown.tsx): a NUL byte
  // can never appear in a mermaid source, so the (dark, source) key is
  // unambiguous — a space is legal mermaid text and would not be.
  const key = `${dark ? 1 : 0}\u0000${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh LRU position on hit.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const id = `omp-ui-t-${blockSeq++}`;
  const run = renderMermaid(id, source, dark);
  cache.set(key, run);
  // A failed render must not poison the key: drop it, and swallow the
  // rejection here so unhandled-rejection tracking never sees the cached
  // promise's failure (each consumer attaches its own catch).
  run.catch(() => {
    if (cache.get(key) === run) cache.delete(key);
  });
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return run;
}

/** `enabled` is false while the block streams (the caret is still riding
 *  it) — same gate CodeBlock already passes to useHighlightTokens. */
export function useDiagramSvg(source: string, enabled: boolean): string | null {
  const [svg, setSvg] = useState<string | null>(null);
  const theme = useTheme();

  useEffect(() => {
    if (!enabled) {
      setSvg(null);
      return;
    }
    let alive = true;
    diagramSvg(source, theme.dark).then(
      (s) => {
        if (alive) setSvg(s);
      },
      () => {
        // failure ⇒ stay on the code block
        if (alive) setSvg(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [source, enabled, theme]);

  return svg;
}
