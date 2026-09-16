// The browser pane wire contract (issue #519, ADR-0029). Pure — zero imports —
// because renderer, desktop main, the server, and the generated extension all
// share it: the renderer imports it via the @omp-ui/core/browser-pane subpath
// exactly like capabilities.ts. The generating half (browser-pane-extension.ts)
// interpolates these constants into the extension source, so the hidden
// command, the custom-message type, and the agent's instruction text can never
// drift between the two sides of the channel.

/** Hidden slash command the spawner sends to arm the extension (`set <json>` / `clear`). */
export const BROWSER_PANE_COMMAND = "omp-ui-browser-pane";
/** `customType` of the one hidden message the agent receives (#530). */
export const BROWSER_PANE_CUSTOM_TYPE = "omp-ui:browser-pane";
/** The one app-wide partition every pane page lives in (#531). */
export const BROWSER_PANE_PARTITION = "persist:browser-pane";
export const BROWSER_PANE_FPS = 30;
export const BROWSER_PANE_JPEG_QUALITY = 70;
export const BROWSER_PANE_MAX_DSF = 2;
export const BROWSER_PANE_FRAME_HEADER_BYTES = 8;
/** A client whose socket buffer is over this misses a lossy frame (#529). */
export const BROWSER_PANE_LOSSY_SKIP_BYTES = 256 * 1024;
/** Root `/json/version` answers only this long after a tokened hit (#531). */
export const BROWSER_PANE_ROOT_VERSION_WINDOW_MS = 5_000;
export const BROWSER_PANE_MAX_CDP_CLIENTS = 8;
/** How long a forwarded input/navigation command keeps the agent state at `acting`. */
export const BROWSER_PANE_ACTING_MS = 1_500;
export const BROWSER_PANE_RESIZE_DEBOUNCE_MS = 100;
export const BROWSER_PANE_DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
export const BROWSER_PANE_MIN_VIEWPORT = 200;
export const BROWSER_PANE_MAX_VIEWPORT = 4096;

export type BrowserPaneAgentState = "detached" | "attached" | "acting";

/** In-band frame header: physical pixel size of the JPEG and the dsf it was painted at. */
export interface BrowserPaneFrameHeader {
  width: number;
  height: number;
  dsf: number;
}

/** u16BE ×4: width, height, round(dsf*100), reserved 0. */
export function encodeBrowserPaneFrameHeader(h: BrowserPaneFrameHeader): Uint8Array {
  const out = new Uint8Array(BROWSER_PANE_FRAME_HEADER_BYTES);
  writeU16(out, 0, h.width);
  writeU16(out, 2, h.height);
  writeU16(out, 4, Math.round(h.dsf * 100));
  return out;
}

/**
 * Splits a wire frame into its header and JPEG bytes. `jpeg` is a subarray of
 * the input (no copy). Null when the frame is shorter than the header, has a
 * zero dimension, or carries a dsf under 0.5.
 */
export function decodeBrowserPaneFrame(
  bytes: Uint8Array,
): { header: BrowserPaneFrameHeader; jpeg: Uint8Array } | null {
  if (bytes.length < BROWSER_PANE_FRAME_HEADER_BYTES) return null;
  const width = readU16(bytes, 0);
  const height = readU16(bytes, 2);
  const dsf = readU16(bytes, 4) / 100;
  if (width === 0 || height === 0 || dsf < 0.5) return null;
  return { header: { width, height, dsf }, jpeg: bytes.subarray(BROWSER_PANE_FRAME_HEADER_BYTES) };
}

/** CSS px the frame covers at the dsf it was painted at. */
export function browserPaneCssSize(h: BrowserPaneFrameHeader): { width: number; height: number } {
  return { width: h.width / h.dsf, height: h.height / h.dsf };
}

function writeU16(out: Uint8Array, offset: number, value: number): void {
  const v = Math.max(0, Math.min(0xffff, Math.round(value)));
  out[offset] = v >>> 8;
  out[offset + 1] = v & 0xff;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
}

export interface BrowserPaneState {
  /** Last committed top-level URL; null before the first load. */
  url: string | null;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** False once the page is destroyed (lifecycle), true while it exists. */
  alive: boolean;
  agent: BrowserPaneAgentState;
}

export type BrowserPaneUnavailableReason = "listener-failed" | "create-failed" | "no-frames";

export type BrowserPaneEnsureResult =
  | { status: "missing-session" | "not-live" | "terminal" }
  | { status: "unavailable"; reason: BrowserPaneUnavailableReason }
  | { status: "available"; state: BrowserPaneState; frame: BrowserPaneFrameHeader | null };

export type BrowserPaneNavigate =
  | { action: "goto"; url: string }
  | { action: "back" | "forward" | "reload" | "stop" };

export type BrowserPaneModifier =
  | "shift"
  | "control"
  | "alt"
  | "meta"
  | "capsLock"
  | "isKeypad"
  | "left"
  | "middle"
  | "right";
export type BrowserPaneMouseButton = "left" | "middle" | "right";
export type BrowserPaneEditCommand = "selectAll" | "copy" | "paste" | "cut" | "undo" | "redo";

/** Mirrors Electron's sendInputEvent unions (CSS px) plus the two non-input verbs. */
export type BrowserPaneInputEvent =
  | {
      type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseLeave";
      x: number;
      y: number;
      button?: BrowserPaneMouseButton;
      clickCount?: number;
      modifiers?: BrowserPaneModifier[];
    }
  | {
      type: "mouseWheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      hasPreciseScrollingDeltas: boolean;
      modifiers?: BrowserPaneModifier[];
    }
  | { type: "keyDown" | "keyUp" | "char"; keyCode: string; modifiers?: BrowserPaneModifier[] }
  | { type: "insertText"; text: string }
  | { type: "edit"; command: BrowserPaneEditCommand };

// Navigation allow-lists (#531). Pure so the renderer's address bar and main's
// three enforcement layers share one rule.

/** http:, https:, or exactly "about:blank". */
export function isAllowedBrowserPaneTopLevelUrl(url: string): boolean {
  if (hasControlCharacters(url)) return false;
  if (url === "about:blank") return true;
  const protocol = parseProtocol(url);
  return protocol === "http:" || protocol === "https:";
}

/** Top-level rule plus about:*, data:, blob:. */
export function isAllowedBrowserPaneSubframeUrl(url: string): boolean {
  if (hasControlCharacters(url)) return false;
  const protocol = parseProtocol(url);
  return (
    protocol === "http:" ||
    protocol === "https:" ||
    protocol === "about:" ||
    protocol === "data:" ||
    protocol === "blob:"
  );
}

function parseProtocol(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

function hasControlCharacters(url: string): boolean {
  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// Hidden slash messages the spawner sends (initialCommands) — the
// capabilitiesMessage() idiom.

export function browserPaneSetMessage(cdpUrl: string): string {
  return `/${BROWSER_PANE_COMMAND} set ${JSON.stringify({ cdpUrl })}`;
}

export function browserPaneClearMessage(): string {
  return `/${BROWSER_PANE_COMMAND} clear`;
}

/** The only endpoint shape the extension accepts: loopback host, port, 256-bit base64url token path. */
export const BROWSER_PANE_ENDPOINT_PATTERN = "^http://127\\.0\\.0\\.1:\\d{1,5}/[A-Za-z0-9_-]{43}$";
const ENDPOINT_RE = new RegExp(BROWSER_PANE_ENDPOINT_PATTERN);

/** Strict parse of the `set` payload; null unless `{ cdpUrl }` matches the endpoint pattern with no extra keys. */
export function parseBrowserPaneSetArgs(args: string): { cdpUrl: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (!("cdpUrl" in parsed) || Object.keys(parsed).length !== 1) return null;
  const cdpUrl = parsed.cdpUrl;
  if (typeof cdpUrl !== "string" || !ENDPOINT_RE.test(cdpUrl)) return null;
  return { cdpUrl };
}

/**
 * The hidden message the agent receives (#530, verbatim), split around the
 * endpoint so the generated extension interpolates the same text.
 */
export const BROWSER_PANE_INSTRUCTION_PARTS: readonly [string, string] = [
  '[omp-ui browser pane] This session has a browser pane the user sees live beside the transcript. Drive it from the eval kernel:\n  const tab = await browser.open({ name: "pane", url: "<http or https URL>", app: { cdp_url: "',
  '" } });\nThe endpoint has exactly one page: every name you open shares it and its `url` navigates it. The user can click and type in the same page at any time, so observe before you act. tab.click hangs against this endpoint; click with tab.run(async ({ page }) => page.click(selector)). tab.close only disconnects; the page stays open for the user. Only http and https URLs load. This supersedes any earlier omp-ui browser pane endpoint.',
];

export function browserPaneInstruction(cdpUrl: string): string {
  return BROWSER_PANE_INSTRUCTION_PARTS[0] + cdpUrl + BROWSER_PANE_INSTRUCTION_PARTS[1];
}
