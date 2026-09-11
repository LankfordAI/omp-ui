/**
 * Mermaid diagram substitution for HTML plans (issue #285, ADR-0020,
 * reworked for the source-range pipeline of the issue #312 follow-up).
 *
 * The planning agent authors diagram *source* in `<pre class="mermaid">…</pre>`
 * blocks; the trusted renderer process renders each block to SVG before the
 * document reaches the sandboxed plan iframe. The agent never computes a
 * coordinate, and the no-JavaScript rule for plan documents stays intact
 * because the host app — not the document — does the rendering.
 *
 * There is no placeholder protocol any more: blocks carry original source
 * ranges (see plan-source.ts), the rendered SVG lands as a splice the
 * composer joins once, and a parse failure yields a located `MERMAID_SYNTAX`
 * diagnostic instead of being swallowed into a callout that verification
 * could never see. Callouts stay for DISPLAY (a historical card shows the
 * escaped source); they no longer decide the outcome.
 */
import type { PlanDiagnostic } from "@omp-ui/core/plan";
import { mixHex } from "./themes";
import type { ParsedPlanSource, PlanDiagramBlock, PlanReplacement } from "./plan-source";

/** Renders one diagram source to an SVG string. `id` is unique per block. */
export type DiagramRenderer = (id: string, source: string, dark?: boolean) => Promise<string>;

/**
 * A mermaid PARSE failure: the source is wrong, so the agent can fix it.
 * Anything else that rejects the pipeline (chunk import, layout/render
 * exception after a good parse) is an application failure by absence.
 */
export class DiagramSyntaxError extends Error {
  /** Diagram-local line when the engine reported one; never an HTML column. */
  readonly diagramLine: number | null;
  constructor(message: string, diagramLine: number | null = null) {
    super(message);
    this.name = "DiagramSyntaxError";
    this.diagramLine = diagramLine;
  }
}

/** The canvas a plan diagram lands on, derived from the active Theme. */
export interface PlanCanvas {
  /** Canvas darkness: selects the mermaid palette and the error callout. */
  dark: boolean;
  /** Opaque #rrggbb canvas and ink, both taken from the same Theme. */
  surface: string;
  ink: string;
}

export interface DiagramTransform {
  /** Splices into the composed document, in block order. */
  replacements: PlanReplacement[];
  /** `MERMAID_SYNTAX` (source) / `RENDER_INVARIANT` (application) findings. */
  diagnostics: PlanDiagnostic[];
}

/**
 * Renders every classified diagram block of the parsed source and returns
 * the splices plus diagnostics. Blocks render sequentially — mermaid's
 * `render()` is not re-entrant-safe across concurrent calls sharing one
 * mermaid instance (the serialized queue lives in `renderMermaid`).
 *
 * A syntax failure yields a `MERMAID_SYNTAX` error diagnostic (source repair)
 * AND a display callout carrying the escaped source, so a historical card can
 * still show the block while a fresh proposal fails preflight. An engine
 * failure yields a `RENDER_INVARIANT` diagnostic with repair `application` —
 * rewriting the diagram would not help.
 *
 * When a `canvas` is given, the block renders for that canvas: `dark` selects
 * the mermaid palette and the error callout, and on a dark canvas authored
 * `classDef`/`style` hexes are re-fitted by `fitDarkPaint` so pale fills stay
 * readable under the canvas ink.
 */
export async function planDiagramTransform(
  parsed: ParsedPlanSource,
  render: DiagramRenderer = renderMermaid,
  canvas?: PlanCanvas,
): Promise<DiagramTransform> {
  const dark = canvas?.dark ?? false;
  const fit = canvas?.dark ? canvas : null;
  const replacements: PlanReplacement[] = [];
  const diagnostics: PlanDiagnostic[] = [];
  for (const block of parsed.diagramBlocks) {
    try {
      const svg = await render(
        `omp-ui-diagram-${block.blockIndex}`,
        fit ? fitDarkPaint(block.sourceText, fit.surface, fit.ink) : block.sourceText,
        dark,
      );
      replacements.push({
        startOffset: block.pre.range.startOffset,
        endOffset: block.pre.range.endOffset,
        // The SVG is GENERATED output placed as data — it never passes
        // through replacement-string semantics.
        text: `<div class="omp-ui-diagram">${svg}</div>`,
      });
    } catch (err) {
      diagnostics.push(diagramDiagnostic(block, err));
      // The callout itself lands on the canvas, so its palette follows the
      // canvas darkness; its <pre> is repainted by the guardrail code plane.
      replacements.push({
        startOffset: block.pre.range.startOffset,
        endOffset: block.pre.range.endOffset,
        text:
          `<div class="omp-ui-diagram-error" style="${
            dark
              ? "border:1px solid #c9963f;background:#2a1e12;color:#f0c9a0"
              : "border:1px solid #b45309;background:#fdf6ec;color:#7c2d12"
          };padding:8px 10px;border-radius:6px">` +
          `<strong>diagram failed to render</strong>` +
          `<pre>${escapeHtml(block.sourceText)}</pre>` +
          `</div>`,
      });
    }
  }
  return { replacements, diagnostics };
}

function diagramDiagnostic(block: PlanDiagramBlock, err: unknown): PlanDiagnostic {
  const loc = block.pre.range;
  const base = {
    code: "MERMAID_SYNTAX" as const,
    stage: "diagram" as const,
    severity: "error" as const,
    blockIndex: block.blockIndex,
    excerpt: block.sourceText.slice(0, 600),
    location: {
      startOffset: loc.startOffset,
      endOffset: loc.endOffset,
      line: block.pre.node.sourceCodeLocation?.startLine ?? 1,
      column: block.pre.node.sourceCodeLocation?.startCol ?? 1,
    },
  };
  if (err instanceof DiagramSyntaxError) {
    return {
      ...base,
      repair: "source",
      message: "the mermaid source does not parse",
      detail:
        err.message.slice(0, 1000) +
        (err.diagramLine !== null ? ` (diagram line ${err.diagramLine})` : ""),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...base,
    code: "RENDER_INVARIANT",
    repair: "application",
    message: "the diagram engine failed after a successful parse",
    detail: message.slice(0, 1000),
  };
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
 *
 * Parse and render are separate steps so the PLAN path can tell a source
 * defect (rejects as {@link DiagramSyntaxError}) from an engine defect
 * (rejects as anything else → an application failure the agent cannot fix).
 * Every call serializes on the module chain — never call `mermaid.render`
 * directly.
 */
export const renderMermaid: DiagramRenderer = (id, source, dark = false) => {
  const run = renderChain.then(async (): Promise<string> => {
    await ensureMermaid(dark);
    // Lazy on purpose: the chunk must stay out of the initial renderer (and
    // verifier) bundle; static import cannot express that.
    const { default: mermaid } = await import("mermaid");
    // Syntax validation first, on the same serialized path: a source that
    // cannot parse must never be reported as an engine problem.
    try {
      await mermaid.parse(source);
    } catch (err) {
      throw syntaxErrorFrom(err);
    }
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  renderChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/** mermaid parse rejections are plain objects ({str, hash}); normalize them. */
function syntaxErrorFrom(err: unknown): DiagramSyntaxError {
  let text: string;
  if (err !== null && typeof err === "object" && "str" in err && typeof err.str === "string") {
    text = err.str;
  } else if (err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }
  const line = /line\s+(\d+)/i.exec(text);
  return new DiagramSyntaxError(text, line === null ? null : Number(line[1]));
}

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
