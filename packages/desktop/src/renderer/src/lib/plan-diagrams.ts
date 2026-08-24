/**
 * Mermaid diagram substitution for HTML plans (issue #285, ADR-0020).
 *
 * The planning agent authors diagram *source* in `<pre class="mermaid">…</pre>`
 * blocks; the trusted renderer process renders each block to SVG before the
 * document reaches the sandboxed plan iframe. The agent never computes a
 * coordinate, and the no-JavaScript rule for plan documents stays intact
 * because the host app — not the document — does the rendering.
 *
 * Kept separate from plan-document.ts so the transform stays unit-testable
 * with an injected stub renderer.
 */

/** Renders one diagram source to an SVG string. `id` is unique per block. */
export type DiagramRenderer = (id: string, source: string) => Promise<string>;

export interface MermaidBlock {
  /** Unique inert placeholder substituted into the document string. */
  placeholder: string;
  /** HTML-entity-decoded mermaid source from the block's inner text. */
  source: string;
}

// Mermaid source cannot legally contain a nested closing </pre>, so a regex
// over the document string is safe here; the document is re-serialized
// wholesale anyway. The class match is a token match so `class="mermaid wide"`
// still counts.
const MERMAID_BLOCK = /<pre\b[^>]*\bclass\s*=\s*(?:"[^"]*(?<![\w-])mermaid(?![\w-])[^"]*"|'[^']*(?<![\w-])mermaid(?![\w-])[^']*')[^>]*>([\s\S]*?)<\/pre\s*>/gi;

const BLOCK_PLACEHOLDER = (n: number) => `<!--omp-ui-diagram-${n}-->`;

/**
 * Finds every `<pre class="mermaid">…</pre>` block, replaces each in `html`
 * with a unique inert HTML-comment placeholder, and returns the
 * placeholder→source pairs. The block's inner text is HTML-entity-decoded
 * (the agent writes `&lt;` for a literal `<` in labels).
 */
export function extractMermaidBlocks(html: string): { html: string; blocks: MermaidBlock[] } {
  const blocks: MermaidBlock[] = [];
  const out = html.replace(MERMAID_BLOCK, (_match, inner: string) => {
    const placeholder = BLOCK_PLACEHOLDER(blocks.length);
    blocks.push({ placeholder, source: decodeEntities(inner) });
    return placeholder;
  });
  return { html: out, blocks };
}

/**
 * Replaces every mermaid block in `html` with rendered SVG wrapped in
 * `<div class="omp-ui-diagram">`, or — when a block fails to render — an error
 * callout carrying the escaped source. Documents without mermaid blocks are
 * returned byte-identically and the mermaid chunk never loads.
 *
 * Blocks render sequentially: mermaid's `render()` is not re-entrant-safe
 * across concurrent calls sharing one mermaid instance.
 */
export async function renderMermaidBlocks(
  html: string,
  render: DiagramRenderer = renderMermaid,
): Promise<string> {
  const { html: staged, blocks } = extractMermaidBlocks(html);
  let out = staged;
  for (const [i, block] of blocks.entries()) {
    let replacement: string;
    try {
      const svg = await render(`omp-ui-diagram-${i}`, block.source);
      replacement = `<div class="omp-ui-diagram">${svg}</div>`;
    } catch {
      replacement =
        `<div class="omp-ui-diagram-error" style="border:1px solid #b45309;background:#fdf6ec;color:#7c2d12;padding:8px 10px;border-radius:6px">` +
        `<strong>diagram failed to render</strong>` +
        `<pre>${escapeHtml(block.source)}</pre>` +
        `</div>`;
    }
    // The placeholder is a unique comment token by construction, so a plain
    // string replace cannot collide with authored content.
    out = out.replace(block.placeholder, replacement);
  }
  return out;
}

let ready: Promise<unknown> | null = null;

function ensureMermaid(): Promise<unknown> {
  return (ready ??= import("mermaid").then(({ default: mermaid }) => {
    // strict: no HTML labels, no click handlers — plan content is untrusted.
    // theme:"base" + themeVariables gives a warm, legible default on the plan's
    // light canvas; the agent can still override per node with classDef/style
    // (pure fill/stroke/color, allowed under strict — issue #286).
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        primaryColor: "#fef3c7",
        primaryBorderColor: "#b45309",
        primaryTextColor: "#1c1917",
        lineColor: "#57534e",
        secondaryColor: "#e0f2fe",
        tertiaryColor: "#f5f5f4",
      },
      // Emit an explicit pixel width equal to the laid-out viewBox instead of
      // width="100%". Combined with the guardrail's max-width cap this renders
      // every diagram at its natural, readable size (issue #288) — node size
      // no longer scales with the column, so tall charts stop ballooning.
      flowchart: { useMaxWidth: false },
    });
  }));
}

/**
 * Default renderer: bundled mermaid, loaded once on the first plan containing
 * a diagram (dynamic import keeps it out of the initial renderer chunk).
 * Render errors re-throw as-is; `renderMermaidBlocks` owns the failure callout.
 */
export const renderMermaid: DiagramRenderer = async (id, source) => {
  await ensureMermaid();
  const { default: mermaid } = await import("mermaid");
  const { svg } = await mermaid.render(id, source);
  return svg;
};

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
