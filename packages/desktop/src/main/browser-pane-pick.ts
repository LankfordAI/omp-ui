import {
  BROWSER_PANE_PICK_SELECTOR_MAX,
  BROWSER_PANE_PICK_TEXT_MAX,
  type BrowserPanePickResult,
} from "@omp-ui/core";
import type { PaneDebugger } from "./browser-pane-contents";

/** Runs in the page with the picked node as `this` and returns a stable, concise selector. */
export const PICK_FUNCTION = `function () {
  let el = this;
  while (el && el.nodeType !== 1) el = el.parentElement || el.parentNode;
  if (!el) return null;
  const esc = (s) => CSS.escape(s);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  let selector = null;
  if (el.id && unique("#" + esc(el.id))) selector = "#" + esc(el.id);
  if (selector === null) {
    const tid = el.getAttribute("data-testid");
    if (tid && unique('[data-testid="' + esc(tid) + '"]')) selector = '[data-testid="' + esc(tid) + '"]';
  }
  if (selector === null) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id && unique("#" + esc(node.id))) { parts.unshift("#" + esc(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      if (unique(parts.join(" > "))) break;
      node = parent;
    }
    selector = parts.join(" > ");
  }
  const r = el.getBoundingClientRect();
  const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  return {
    selector, tag: el.tagName.toLowerCase(), text,
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    framed: window.top !== window,
  };
}`;

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function numberPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [x, y] = value;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? [x, y]
    : null;
}

/** Strictly validates page-authored data before returning it to the renderer. */
function toPickResult(value: unknown): BrowserPanePickResult {
  const selector = field(value, "selector");
  const tag = field(value, "tag");
  const text = field(value, "text");
  const framed = field(value, "framed");
  const rect = field(value, "rect");
  const x = field(rect, "x");
  const y = field(rect, "y");
  const width = field(rect, "width");
  const height = field(rect, "height");
  if (
    typeof selector !== "string" || selector.length === 0 ||
    typeof tag !== "string" || typeof text !== "string" || typeof framed !== "boolean" ||
    typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y) ||
    typeof width !== "number" || !Number.isFinite(width) || typeof height !== "number" || !Number.isFinite(height)
  ) return { status: "miss" };
  return {
    status: "picked",
    selector: selector.slice(0, BROWSER_PANE_PICK_SELECTOR_MAX),
    tag: tag.slice(0, 64),
    text: text.slice(0, BROWSER_PANE_PICK_TEXT_MAX),
    framed,
    rect: { x, y, width, height },
  };
}

/** Hit-tests a viewport point through the page's root debugger session. */
export async function pickElement(dbg: PaneDebugger, x: number, y: number): Promise<BrowserPanePickResult> {
  const scroll = await dbg.sendCommand("Runtime.evaluate", {
    expression: "[window.scrollX, window.scrollY]",
    returnByValue: true,
  });
  const [sx, sy] = numberPair(field(field(scroll, "result"), "value")) ?? [0, 0];
  let hit: unknown;
  try {
    hit = await dbg.sendCommand("DOM.getNodeForLocation", {
      x: Math.round(x + sx),
      y: Math.round(y + sy),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false,
    });
  } catch {
    return { status: "miss" };
  }
  const backendNodeId = field(hit, "backendNodeId");
  if (typeof backendNodeId !== "number") return { status: "miss" };
  const resolved = await dbg.sendCommand("DOM.resolveNode", { backendNodeId });
  const objectId = field(field(resolved, "object"), "objectId");
  if (typeof objectId !== "string") return { status: "miss" };
  try {
    const reply = await dbg.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: PICK_FUNCTION,
      returnByValue: true,
    });
    return toPickResult(field(field(reply, "result"), "value"));
  } finally {
    void dbg.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}
