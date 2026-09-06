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
import { mixHex } from "./themes";

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

/** The canvas a plan diagram lands on, derived from the active Theme. */
export interface PlanCanvas {
  /** Canvas darkness: selects the mermaid palette and the error callout. */
  dark: boolean;
  /** Opaque #rrggbb canvas and ink, both taken from the same Theme. */
  surface: string;
  ink: string;
}

/**
 * Replaces every mermaid block in `html` with rendered SVG wrapped in
 * `<div class="omp-ui-diagram">`, or — when a block fails to render — an error
 * callout carrying the escaped source. Documents without mermaid blocks are
 * returned byte-identically and the mermaid chunk never loads.
 *
 * When a `canvas` is given, the block renders for that canvas: `dark` selects
 * the mermaid palette and the error callout, and on a dark canvas authored
 * `classDef`/`style` hexes are re-fitted by `fitDarkPaint` so pale fills stay
 * readable under the canvas ink.
 *
 * Blocks render sequentially: mermaid's `render()` is not re-entrant-safe
 * across concurrent calls sharing one mermaid instance.
 */
export async function renderMermaidBlocks(
  html: string,
  render: DiagramRenderer = renderMermaid,
  canvas?: PlanCanvas,
): Promise<string> {
  const dark = canvas?.dark ?? false;
  const fit = canvas?.dark ? canvas : null;
  const { html: staged, blocks } = extractMermaidBlocks(html);
  let out = staged;
  for (const [i, block] of blocks.entries()) {
    let replacement: string;
    try {
      const svg = await render(
        `omp-ui-diagram-${i}`,
        fit ? fitDarkPaint(block.source, fit.surface, fit.ink) : block.source,
        dark,
      );
      replacement = `<div class="omp-ui-diagram">${svg}</div>`;
    } catch {
      // The callout itself lands on the canvas, so its palette follows the
      // canvas darkness; its <pre> is repainted by the guardrail code plane.
      replacement =
        `<div class="omp-ui-diagram-error" style="${
          dark
            ? "border:1px solid #c9963f;background:#2a1e12;color:#f0c9a0"
            : "border:1px solid #b45309;background:#fdf6ec;color:#7c2d12"
        };padding:8px 10px;border-radius:6px">` +
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

/* Authored-paint fit (issue #384): plans are told to colour diagrams with
 * classDef/style (ADR-0020), so a pale authored fill lands as an unreadable
 * card carrying canvas-ink labels on a dark canvas. Mermaid source is still
 * text at substitution time, so the fix is a deterministic re-fit of hexes on
 * classDef and style lines — never a CSS hack, and never a label rewrite. */
const FIT_LINE = /^[ \t]*(?:classDef|style)[ \t]/;
// Alternation keeps 4- and 8-digit hexes (RGBA forms) out of reach; the
// lookahead must sit on the 3-digit branch too or #rrggbbaa truncates to rgb.
const PAINT =
  /\b(fill|stroke)[ \t]*:[ \t]*(#[0-9a-fA-F]{3}(?![0-9a-fA-F])|#[0-9a-fA-F]{6}(?![0-9a-fA-F]))/g;
/** Weights tried toward the base; monotone descent, so the ladder ends. */
const FILL_LADDER = [0.35, 0.2, 0.1] as const;
const STROKE_LADDER = [0.65, 0.5, 0.35] as const;
/** Fills carry labels (AA); strokes are edges (the UI 3:1 tier). */
const FILL_FLOOR = 4.5;
const STROKE_FLOOR = 3;

/** `#rgb` → `#rrggbb`; mixHex throws on anything but 6-digit, too. */
function expandHex(hex: string): string {
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

/** WCAG relative luminance; mirrors the local copy in themes.test.ts so the
 *  fit's gate has no dependency that can go stale. */
function luminance(hex: string): number {
  const h = expandHex(hex).replace("#", "").slice(0, 6);
  const channel = (offset: number): number => {
    const c = Number.parseInt(h.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio; 3-digit hex is expanded before use. */
function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function fitPaint(hex: string, isFill: boolean, surface: string, ink: string): string {
  const base = isFill ? surface : ink;
  const ok = (c: string): boolean =>
    isFill ? contrastRatio(ink, c) >= FILL_FLOOR : contrastRatio(c, surface) >= STROKE_FLOOR;
  // Already readable: pass through, which makes the fit idempotent.
  if (ok(hex)) return hex;
  for (const weight of isFill ? FILL_LADDER : STROKE_LADDER) {
    const mixed = mixHex(hex, base, weight);
    if (ok(mixed)) return mixed;
  }
  // Last resort: the canvas itself — gated ≥4.5 against ink by themes.test.ts.
  return base;
}

/**
 * Rewrites every `fill:`/`stroke:` hex on `classDef`/`style` lines of a
 * mermaid source so it stays readable on a dark canvas: fills are pulled
 * toward `surface` until the canvas ink painted over them clears AA, strokes
 * toward `ink` until they clear 3:1 against the canvas. Lines the parser does
 * not read as paint statements — node labels in particular — are never
 * touched, and a hex that already passes is returned unchanged.
 */
export function fitDarkPaint(source: string, surface: string, ink: string): string {
  return source
    .split("\n")
    .map((line) =>
      FIT_LINE.test(line)
        ? line.replace(PAINT, (_whole, kind: string, hex: string) =>
            `${kind}:${fitPaint(expandHex(hex), kind === "fill", surface, ink)}`,
          )
        : line,
    )
    .join("\n");
}

/** Diagram palettes keyed by canvas darkness: plans pass the active theme's
 *  darkness (issue #384) and transcript diagrams the app's (issue #361).
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
 * it out of the initial renderer chunk). `dark` selects the palette matched to
 * the canvas the diagram lands on — both the plan and transcript paths pass it
 * (issues #361, #384).
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
