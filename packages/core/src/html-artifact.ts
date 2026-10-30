// Interactive HTML artifacts (issue #994, ADR-0082). Pure — no `node:` or
// Electron imports — because three places speak this one contract: main's
// HostBridge validates the `omp-ui_render_html` call, main's webview guard
// confines the guest that runs the document, and the renderer composes the
// document and renders the card from the tool call's own arguments (which omp
// persists in the session file, so a reload or a joined viewer re-renders it
// with nothing stored host-side).

/** The host tool's name: namespaced like every omp-ui host tool (ADR-0043). */
export const HTML_ARTIFACT_TOOL_NAME = "omp-ui_render_html";

/** The Electron partition every artifact guest runs in. No `persist:` prefix:
 *  an in-memory session, so nothing an artifact stores outlives the app. */
export const HTML_ARTIFACT_PARTITION = "omp-ui-artifacts";

/** One document's byte budget. It rides the tool call's arguments into the
 *  session file and every replay, so it is bounded like any transcript datum. */
export const HTML_ARTIFACT_MAX_BYTES = 512 * 1024;

export const HTML_ARTIFACT_TITLE_MAX = 200;

/** Inline frame height bounds in CSS px; expand-to-full-view has no inline cap. */
export const HTML_ARTIFACT_MIN_HEIGHT = 120;
export const HTML_ARTIFACT_MAX_HEIGHT = 1200;
export const HTML_ARTIFACT_DEFAULT_HEIGHT = 420;

/**
 * The artifact document's policy. Scripts and styles inline only; images,
 * fonts and media from data:/blob: only; no connect-src (default-src covers
 * fetch, XHR, WebSocket, EventSource, beacons), no frames, workers, objects,
 * forms, or base rewrites. CSP has no directive for WebRTC — the guest's
 * session closes that hole underneath (ADR-0082).
 */
export const HTML_ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; " +
  "frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

/** The static fallback's policy: the same document with no script at all. */
export const HTML_ARTIFACT_STATIC_CSP = HTML_ARTIFACT_CSP.replace(
  "script-src 'unsafe-inline'",
  "script-src 'none'",
);

export interface HtmlArtifactArgs {
  title: string;
  html: string;
  height: number;
}

const encoder = new TextEncoder();

/** UTF-8 byte length without allocating the encoded copy for ASCII-only text. */
function utf8Length(text: string): number {
  // eslint-disable-next-line no-control-regex
  return /^[\u0000-\u007f]*$/.test(text) ? text.length : encoder.encode(text).length;
}

function clampHeight(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return HTML_ARTIFACT_DEFAULT_HEIGHT;
  return Math.round(Math.min(HTML_ARTIFACT_MAX_HEIGHT, Math.max(HTML_ARTIFACT_MIN_HEIGHT, raw)));
}

/**
 * Validates the tool's arguments. Main answers the model with the refusal
 * reason; the renderer uses the same verdict so a card never shows a document
 * the tool refused.
 */
export function parseHtmlArtifactArgs(
  raw: unknown,
): { ok: true; args: HtmlArtifactArgs } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "arguments must be an object with title and html" };
  }
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (title === "") return { ok: false, reason: "title must be a non-empty string" };
  if (title.length > HTML_ARTIFACT_TITLE_MAX) {
    return { ok: false, reason: `title is longer than ${HTML_ARTIFACT_TITLE_MAX} characters` };
  }
  const html = typeof record.html === "string" ? record.html : "";
  if (html.trim() === "") return { ok: false, reason: "html must be a non-empty string" };
  const bytes = utf8Length(html);
  if (bytes > HTML_ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      reason: `html is ${bytes} bytes; the limit is ${HTML_ARTIFACT_MAX_BYTES} bytes (inline your data, drop unused libraries)`,
    };
  }
  return { ok: true, args: { title, html, height: clampHeight(record.height) } };
}

/** The tool's answer to the model. Setting-free on purpose: the machine that
 *  displays the card decides whether scripts run, and for a joined tab that is
 *  the viewer, not the owner answering here. */
export function htmlArtifactResultText(args: HtmlArtifactArgs): string {
  return (
    `Rendered "${args.title}" (${utf8Length(args.html)} bytes) inline in the user's transcript. ` +
    "Its scripts run sandboxed with no network, storage, popups, forms, or navigation; " +
    "if the user turned artifact scripts off in Settings, it shows as a static document."
  );
}

/** The CSS custom properties an artifact may read, from one theme's tokens. */
export function htmlArtifactThemeCss(tokens: Readonly<Record<string, string>>, dark: boolean): string {
  const vars = Object.entries(tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${dark ? "dark" : "light"};${vars}}`;
}

/**
 * The document a card displays: the CSP meta first in the head, then the
 * theme variables, then the author's bytes untouched. Ahead of the author's
 * markup, the parser hoists this head for a fragment and a full document alike
 * (a later `<html>`/`<head>` merges into the open elements), so the policy is
 * in force before any authored script runs; a parsed `<meta>` CSP cannot be
 * lifted by script.
 */
export function composeHtmlArtifactDocument(html: string, themeCss: string, scripts: boolean): string {
  const csp = scripts ? HTML_ARTIFACT_CSP : HTML_ARTIFACT_STATIC_CSP;
  return (
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${themeCss}html{background:var(--color-surface);color:var(--color-ink)}</style>` +
    `</head><body>${html}`
  );
}

/** The guest's one URL: the composed document as a base64 data: URL. A data:
 *  document is an opaque origin with no host to reach back to. */
export function htmlArtifactDataUrl(document: string): string {
  const bytes = encoder.encode(document);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`;
}

/**
 * The guest session's request filter: only the document itself and the
 * data:/blob:/about: resources CSP already admits may load. Everything else is
 * cancelled at the network layer even if CSP were bypassed.
 */
export function isHtmlArtifactRequestAllowed(url: string): boolean {
  return /^(?:data|blob|about):/i.test(url);
}
