import type {
  BrowserPaneEditCommand,
  BrowserPaneFrameHeader,
  BrowserPaneInputEvent,
  BrowserPaneModifier,
  BrowserPaneMouseButton,
} from "@omp-ui/core/browser-pane";

/**
 * DOM input → browser pane wire events (issue #519, spec section 7). Pure:
 * every function takes plain data, so the table is testable without jsdom
 * and the component stays a thin adapter (read the DOM event, call, send).
 * `darwin` is injected because ⌘-chords map to `edit` commands only there.
 */

export interface ModifierFlags {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** `getModifierState("CapsLock")` at the DOM boundary. */
  capsLock: boolean;
}

export interface PointerLike extends ModifierFlags {
  offsetX: number;
  offsetY: number;
  button: number;
  buttons: number;
  detail: number;
}

export interface WheelLike extends ModifierFlags {
  offsetX: number;
  offsetY: number;
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
}

export interface KeyLike extends ModifierFlags {
  key: string;
  /** `KeyboardEvent.location`; 3 is the numeric keypad. */
  location: number;
  isComposing: boolean;
}

/** CSS px box the canvas paints into. */
export interface CssBox {
  width: number;
  height: number;
}

export interface PointerContext {
  box: CssBox;
  header: BrowserPaneFrameHeader;
}

export type PointerKind = "down" | "up" | "move" | "leave";

/** One DOM line of wheel travel, in CSS px, when `deltaMode` is lines. */
const WHEEL_LINE_PX = 16;

const MOUSE_BUTTON: Record<number, BrowserPaneMouseButton> = { 0: "left", 1: "middle", 2: "right" };

/** `MouseEvent.buttons` bit → button, in the order a drag reports its primary. */
const BUTTONS_BITS: readonly [number, BrowserPaneMouseButton][] = [
  [1, "left"],
  [2, "right"],
  [4, "middle"],
];

const EDIT_CHORD: Record<string, BrowserPaneEditCommand> = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
};

/** DOM `key` names that Electron's accelerator table spells differently. */
const KEY_NAME: Record<string, string> = {
  " ": "Space",
  Enter: "Return",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Escape: "Escape",
  Backspace: "Backspace",
  Tab: "Tab",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
};

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

/**
 * Canvas offset → page CSS px, rounded to 0.5 px (Chromium's own pointer
 * precision). The canvas paints the frame stretched to its box, so each axis
 * scales by frame-CSS-size / box-size independently.
 */
export function mapPointer(
  offsetX: number,
  offsetY: number,
  box: CssBox,
  header: BrowserPaneFrameHeader,
): { x: number; y: number } {
  const cssWidth = header.width / header.dsf;
  const cssHeight = header.height / header.dsf;
  const x = box.width > 0 ? (offsetX * cssWidth) / box.width : offsetX;
  const y = box.height > 0 ? (offsetY * cssHeight) / box.height : offsetY;
  return { x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2 };
}

function modifiers(flags: ModifierFlags, extra?: BrowserPaneModifier[]): BrowserPaneModifier[] | undefined {
  const out: BrowserPaneModifier[] = [];
  if (flags.shiftKey) out.push("shift");
  if (flags.ctrlKey) out.push("control");
  if (flags.altKey) out.push("alt");
  if (flags.metaKey) out.push("meta");
  if (flags.capsLock) out.push("capsLock");
  if (extra) out.push(...extra);
  return out.length > 0 ? out : undefined;
}

/** The buttons a pointer holds down, as the wire's button modifiers. */
function heldButtons(buttons: number): BrowserPaneMouseButton[] {
  const out: BrowserPaneMouseButton[] = [];
  for (const [bit, name] of BUTTONS_BITS) if ((buttons & bit) !== 0) out.push(name);
  return out;
}

export function pointerEvents(
  kind: PointerKind,
  e: PointerLike,
  ctx: PointerContext,
): BrowserPaneInputEvent[] {
  const { x, y } = mapPointer(e.offsetX, e.offsetY, ctx.box, ctx.header);
  if (kind === "leave") return [{ type: "mouseLeave", x, y }];
  if (kind === "move") {
    const held = heldButtons(e.buttons);
    const button = held[0];
    return [
      button === undefined
        ? { type: "mouseMove", x, y, modifiers: modifiers(e) }
        : { type: "mouseMove", x, y, button, modifiers: modifiers(e, held) },
    ];
  }
  const button = MOUSE_BUTTON[e.button];
  if (button === undefined) return [];
  // A right-button release is routinely eaten by the context menu the press
  // opened, so the press carries both halves and the release sends nothing.
  if (button === "right" && kind === "up") return [];
  const base = { x, y, button, clickCount: e.detail || 1, modifiers: modifiers(e) };
  if (button === "right") {
    return [
      { type: "mouseDown", ...base },
      { type: "mouseUp", ...base },
    ];
  }
  return [{ type: kind === "down" ? "mouseDown" : "mouseUp", ...base }];
}

/**
 * DOM positive `deltaY` means the content scrolls down; Chromium's wheel
 * event carries the opposite sign, hence the negation on both axes.
 */
export function wheelEvents(e: WheelLike, ctx: PointerContext): BrowserPaneInputEvent[] {
  const { x, y } = mapPointer(e.offsetX, e.offsetY, ctx.box, ctx.header);
  const scale = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? ctx.box.height : 1;
  return [
    {
      type: "mouseWheel",
      x,
      y,
      deltaX: -e.deltaX * scale,
      deltaY: -e.deltaY * scale,
      hasPreciseScrollingDeltas: e.deltaMode === 0,
      modifiers: modifiers(e),
    },
  ];
}

/** A single grapheme: one UTF-16 unit or one surrogate pair. */
function isSingleGrapheme(key: string): boolean {
  if (key.length === 1) return true;
  if (key.length !== 2) return false;
  const lead = key.charCodeAt(0);
  return lead >= 0xd800 && lead <= 0xdbff;
}

/** Electron accelerator name for a DOM `key`; null for dead keys and names the table lacks. */
export function acceleratorName(key: string): string | null {
  const named = KEY_NAME[key];
  if (named !== undefined) return named;
  if (FUNCTION_KEY.test(key)) return key;
  if (isSingleGrapheme(key)) return /^[a-z]$/i.test(key) ? key.toUpperCase() : key;
  return null;
}

export interface KeyTranslation {
  events: BrowserPaneInputEvent[];
  /** True when the page owns the key; false lets the DOM default proceed. */
  preventDefault: boolean;
}

const DROPPED: KeyTranslation = { events: [], preventDefault: false };

export function keyEvents(
  kind: "keydown" | "keyup",
  e: KeyLike,
  { darwin }: { darwin: boolean },
): KeyTranslation {
  // The IME composes into the hidden proxy; compositionend delivers the text.
  if (e.isComposing) return DROPPED;
  if (darwin && e.metaKey && !e.ctrlKey && !e.altKey) {
    const command = EDIT_CHORD[e.key.toLowerCase()];
    if (command !== undefined) {
      if (kind === "keyup") return { events: [], preventDefault: true };
      const resolved = command === "undo" && e.shiftKey ? "redo" : command;
      return { events: [{ type: "edit", command: resolved }], preventDefault: true };
    }
  }
  const keyCode = acceleratorName(e.key);
  if (keyCode === null) return DROPPED;
  const mods = modifiers(e, e.location === 3 ? ["isKeypad"] : undefined);
  if (kind === "keyup") return { events: [{ type: "keyUp", keyCode, modifiers: mods }], preventDefault: true };
  const events: BrowserPaneInputEvent[] = [{ type: "keyDown", keyCode, modifiers: mods }];
  const printable = isSingleGrapheme(e.key) && !e.ctrlKey && !e.metaKey;
  if (printable) events.push({ type: "char", keyCode: e.key, modifiers: mods });
  return { events, preventDefault: true };
}

/** `compositionend` → the committed text; an empty commit (cancelled IME) sends nothing. */
export function compositionEnd(data: string): BrowserPaneInputEvent[] {
  return data === "" ? [] : [{ type: "insertText", text: data }];
}
