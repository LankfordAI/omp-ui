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
export type DiagramRenderer = (id: string, source: string, dark?: boolean) => Promise<string>;

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

/** Diagram palettes keyed by canvas darkness (issue #285 keeps the light plan
 *  canvas; transcript diagrams follow the app theme, issue #361).
 *  theme:"base" makes themeVariables apply. */
const LIGHT_VARS = {
  primaryColor: "#fef3c7",
  primaryBorderColor: "#b45309",
  primaryTextColor: "#1c1917",
  lineColor: "#57534e",
  secondaryColor: "#e0f2fe",
  tertiaryColor: "#f5f5f4",
} as const;
const DARK_VARS = {
  primaryColor: "#3a3223",
  primaryBorderColor: "#c9963f",
  primaryTextColor: "#f2ede3",
  lineColor: "#a8a29a",
  secondaryColor: "#22344a",
  tertiaryColor: "#2e2a25",
} as const;

let ready: Promise<unknown> | null = null;
let readyDark: boolean | null = null;

function ensureMermaid(dark: boolean): Promise<unknown> {
  if (ready !== null && readyDark === dark) return ready;
  ready = import("mermaid").then(({ default: mermaid }) => {
    // strict: sanitized labels, no click handlers — plan/transcript content is
    // untrusted.
    // htmlLabels:false (root level) renders labels as SVG <text> instead of
    // <foreignObject> HTML. strict does NOT disable HTML labels (it only
    // sanitizes them); FO labels re-wrap at the column-scaled SVG width and
    // clip at the FO's fixed height, and plan/guardrail CSS reaches into them
    // (issue #303). Root level is required: flowchart.htmlLabels is deprecated
    // and the root default overrides it (mermaid 11.17 config precedence).
    // theme:"base" + themeVariables gives a palette matched to the canvas the
    // diagram lands on; the agent can still override per node with
    // classDef/style (pure fill/stroke/color, allowed under strict — #286).
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // On a parse error mermaid draws its own error SVG into a temporary div
      // appended to document.body before throwing — both callers own their
      // fallback (the plan callout, the transcript code block), so suppress
      // it; the temp element otherwise leaks into the host DOM.
      suppressErrorRendering: true,
      theme: "base",
      htmlLabels: false,
      themeVariables: dark ? DARK_VARS : LIGHT_VARS,
      // Emit an explicit pixel width equal to the laid-out viewBox instead of
      // width="100%". Combined with the CSS max-width cap this renders every
      // diagram at its natural, readable size (issue #288) — node size no
      // longer scales with the column, so tall charts stop ballooning.
      flowchart: { useMaxWidth: false },
    });
    readyDark = dark;
  });
  return ready;
}

// mermaid's global initialize + render is not re-entrant-safe across one
// instance (ADR-0020); plans render sequentially by loop, transcript blocks
// mount concurrently from React effects — so both paths serialize here.
let renderChain: Promise<unknown> = Promise.resolve();

/**
 * Default renderer: bundled mermaid, loaded on first use (dynamic import keeps
 * it out of the initial renderer chunk). `dark` selects the transcript palette;
 * plans omit it and keep the light canvas palette (issue #285).
 * Render errors re-throw as-is; each caller owns its fallback. Every call
 * serializes on the module chain — never call `mermaid.render` directly.
 */
export const renderMermaid: DiagramRenderer = (id, source, dark = false) => {
  const run = renderChain.then(async () => {
    await ensureMermaid(dark);
    const { default: mermaid } = await import("mermaid");
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  renderChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
