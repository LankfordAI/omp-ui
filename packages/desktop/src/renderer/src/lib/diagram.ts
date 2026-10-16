import { useEffect, useState } from "react";
import { renderMermaid } from "./plan-diagrams";
import { useTheme } from "./themes";

/**
 * SVG plus failure for a settled mermaid source (issue #878): while streaming
 * or in flight both fields are null and the caller keeps showing the code
 * block; on a parse failure the message rides so the transcript can surface
 * why. Transcript counterpart of planDiagramTransform for HTML plans (issue
 * #285, extended to the transcript by issue #361): mermaid runs in the
 * trusted renderer with securityLevel "strict"; the returned SVG is sanitizer
 * output, inserted like KaTeX markup in Markdown.tsx.
 */
/** Rendered-SVG cache keyed (dark, source): the transcript re-renders its
 *  items often (streaming commits, theme switches, pane remounts) and one
 *  mermaid render costs ~100 ms. In-flight promises dedupe identical sources
 *  rendered by sibling blocks. LRU-capped: transcripts are long. */
const CACHE_CAP = 64;
const cache = new Map<string, Promise<string>>();

/** Failure messages keyed like the SVG cache. A settled transcript diagram
 * that cannot parse must stay visibly broken (issue #878): re-renders reuse
 * the message instead of re-running mermaid, and a rejected promise never
 * lives here — the success cache stays fail-free. */
const ERR_CAP = 64;
const errorsBySource = new Map<string, string>();

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
  const settledError = errorsBySource.get(key);
  if (settledError !== undefined) return Promise.reject(new Error(settledError));
  const id = `omp-ui-t-${blockSeq++}`;
  const run = renderMermaid(id, source, dark);
  cache.set(key, run);
  // A failed render must not poison the key: drop it and keep the message
  // beside it instead (issue #878 — the transcript strip reads it across
  // re-renders without re-running mermaid). The rejection is swallowed here
  // so unhandled-rejection tracking never sees the cached promise's failure
  // (each consumer attaches its own catch).
  run.catch((err: unknown) => {
    if (cache.get(key) === run) cache.delete(key);
    const message = err instanceof Error ? err.message : String(err);
    errorsBySource.set(key, message);
    if (errorsBySource.size > ERR_CAP) {
      const oldest = errorsBySource.keys().next().value;
      if (oldest !== undefined) errorsBySource.delete(oldest);
    }
  });
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return run;
}

export interface DiagramState {
  svg: string | null;
  /** Parser message for a settled failed render; null while streaming, in
   * flight, or on success — the transcript strip never flashes mid-stream. */
  error: string | null;
}

/** `enabled` is false while the block streams (the caret is still riding
 *  it) — same gate CodeBlock already passes to useHighlightTokens. */
export function useDiagramSvg(source: string, enabled: boolean): DiagramState {
  const [state, setState] = useState<DiagramState>({ svg: null, error: null });
  const theme = useTheme();

  useEffect(() => {
    if (!enabled) {
      setState({ svg: null, error: null });
      return;
    }
    let alive = true;
    diagramSvg(source, theme.dark).then(
      (s) => {
        if (alive) setState({ svg: s, error: null });
      },
      (err: unknown) => {
        // Failure ⇒ keep the code block and carry the parser message so the
        // caller can surface why (issue #878).
        const message = err instanceof Error ? err.message : String(err);
        if (alive) setState({ svg: null, error: message });
      },
    );
    return () => {
      alive = false;
    };
  }, [source, enabled, theme]);

  return state;
}
