// PROTOTYPE (#527) — throwaway. Renderer-only frame source: a per-(url, size)
// set of JPEG frames (24 page + 8 loading) pre-encoded from an OffscreenCanvas
// and looped at 8 fps as Uint8Array bytes — the shape the engine hypothesis in
// #521 would deliver. Chromium only (convertToBlob, no toBlob fallback).
import { latestFrame, type BrowserPaneState } from "./state";

export interface FakeFrame {
  seq: number;
  jpeg: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

/**
 * A per-(url, size) frame set. Arrays fill incrementally while the encoder
 * runs: the loop paints whatever exists, so the first frame shows after one
 * encode, not thirty-two. That matters because convertToBlob is paced by the
 * compositor — an occluded window (no Wayland frame callbacks) encodes at ~1
 * frame per second.
 */
interface FrameSet {
  page: Uint8Array<ArrayBuffer>[];
  loading: Uint8Array<ArrayBuffer>[];
  width: number;
  height: number;
}

const PAGE_FRAMES = 24;
const LOADING_FRAMES = 8;
const CACHE_MAX = 6;
const SIZE_DEBOUNCE_MS = 150;
const LOADING_MS = 900;

const cache = new Map<string, FrameSet>();

let warned = false;
function warnOnce(where: string, err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[prototype-browser-pane] ${where} failed; skipping frames`, err);
}

/* ---------------------------------------------------------------- drawing */

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke !== undefined) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

/** Deterministic fake page: coordinates in CSS px; `phase` is the 0..23 loop position. */
export function drawFakePage(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, url: string, phase: number): void {
  const parsed = new URL(url);
  const host = parsed.host;
  const hue = fnv1a32(host) % 360;
  const accent = `hsl(${hue} 45% 38%)`;
  const inner = w - 48;

  ctx.fillStyle = "#f6f7f9";
  ctx.fillRect(0, 0, w, h);

  // Site bar
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, w, 56);
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 18px system-ui";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(host, 24, 35);
  for (let i = 0; i < 4; i++) {
    const x = w - 24 - (i + 1) * 72 - i * 8;
    if (x < 200) break;
    roundRect(ctx, x, 16, 72, 24, 12, "rgba(255,255,255,.18)");
  }

  // Search box with blinking caret
  roundRect(ctx, 24, 72, Math.min(420, inner), 36, 8, "#ffffff", "#e3e7eb");
  if (phase % 8 < 4) {
    ctx.fillStyle = "#1f2933";
    ctx.fillRect(40, 82, 1, 16);
  }

  // Hero
  const segment = parsed.pathname.split("/").filter((s) => s !== "").pop();
  const title = segment === undefined
    ? "Home"
    : segment.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  ctx.fillStyle = "#1f2933";
  ctx.font = "700 32px system-ui";
  ctx.fillText(title, 24, 176, inner);
  ctx.fillStyle = "#d9dde3";
  ctx.fillRect(24, 196, Math.min(520, inner), 12);

  // Cards (dropped when short; stacked when narrow)
  const tall = h >= 400;
  let bodyStart = 256;
  if (tall) {
    const stacked = w < 320;
    const cardH = stacked ? 72 : 120;
    const cardW = stacked ? inner : (inner - 32) / 3;
    for (let i = 0; i < 3; i++) {
      const x = stacked ? 24 : 24 + i * (cardW + 16);
      const y = stacked ? 256 + i * (cardH + 16) : 256;
      roundRect(ctx, x, y, cardW, cardH, 10, "#ffffff", "#e3e7eb");
      ctx.fillStyle = "#d9dde3";
      ctx.fillRect(x + 16, y + 24, cardW * 0.6 - 16, 10);
      ctx.fillRect(x + 16, y + 44, cardW * 0.4 - 16, 10);
      ctx.fillStyle = accent;
      const square = stacked ? 20 : 36;
      ctx.fillRect(x + 16, y + cardH - 16 - square, square, square);
      if (Math.floor(phase / 8) === i) {
        ctx.beginPath();
        ctx.roundRect(x - 1, y - 1, cardW + 2, cardH + 2, 11);
        ctx.lineWidth = 2;
        ctx.strokeStyle = accent;
        ctx.stroke();
      }
    }
    bodyStart = stacked ? 256 + 3 * (72 + 16) + 16 : 408;
  }

  // Body bars
  const widths = [0.92, 0.78, 0.85, 0.6];
  ctx.fillStyle = "#d9dde3";
  let row = 0;
  for (let y = bodyStart; y < h - 48; y += 22, row++) {
    if (row % 5 === 4) {
      y -= 10; // a 12 px gap instead of a 22 px row
      continue;
    }
    ctx.fillRect(24, y, inner * widths[row % widths.length], 10);
  }

  // Footer
  ctx.fillStyle = "#6b7785";
  ctx.font = "12px ui-monospace";
  ctx.textAlign = "left";
  ctx.fillText(url, 24, h - 16, Math.max(40, inner - 140)); // leave room for the frame counter
  ctx.fillStyle = "#9aa5b1";
  ctx.font = "10px ui-monospace";
  ctx.textAlign = "right";
  ctx.fillText(`PROTOTYPE FRAME ${phase + 1}/${PAGE_FRAMES}`, w - 24, h - 16);
}

function drawLoadingFrame(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, url: string, step: number): void {
  const hue = fnv1a32(new URL(url).host) % 360;
  ctx.fillStyle = "#f6f7f9";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `hsl(${hue} 45% 38%)`;
  ctx.fillRect(0, 0, (w * (step + 1)) / LOADING_FRAMES, 3);
  ctx.fillStyle = "#9aa5b1";
  ctx.font = "10px ui-monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`PROTOTYPE LOADING ${step + 1}/${LOADING_FRAMES}`, w - 24, h - 16);
}

/* --------------------------------------------------------------- encoding */

async function fillSet(set: FrameSet, url: string, cssW: number, cssH: number, dpr: number): Promise<void> {
  const canvas = new OffscreenCanvas(set.width, set.height);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("OffscreenCanvas 2d context unavailable");
  const encode = async (): Promise<Uint8Array<ArrayBuffer>> => {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    return new Uint8Array(await blob.arrayBuffer());
  };
  // Loading frames first: a fresh URL always starts in the 900 ms sweep.
  for (let step = 0; step < LOADING_FRAMES; step++) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLoadingFrame(ctx, cssW, cssH, url, step);
    set.loading.push(await encode());
  }
  for (let phase = 0; phase < PAGE_FRAMES; phase++) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFakePage(ctx, cssW, cssH, url, phase);
    set.page.push(await encode());
  }
}

function requestSet(key: string, url: string, cssW: number, cssH: number, dpr: number, width: number, height: number): FrameSet {
  let set = cache.get(key);
  if (set === undefined) {
    set = { page: [], loading: [], width, height };
    cache.set(key, set);
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    fillSet(set, url, cssW, cssH, dpr).catch((err: unknown) => {
      cache.delete(key);
      warnOnce("convertToBlob", err);
    });
  }
  return set;
}

/* ------------------------------------------------------------------- loop */

export function startFakeFrames(opts: {
  tabId: string;
  /** Container size in CSS px; {0,0} while hidden (display:none tab, collapsed pane). */
  size: () => { width: number; height: number };
  model: () => Pick<BrowserPaneState, "url" | "loading" | "loadingSince">;
  onFrame: (frame: FakeFrame) => void;
  fps?: number;
}): () => void {
  const { tabId, size, model, onFrame, fps = 8 } = opts;
  let seq = 0;
  let current: FrameSet | null = null;
  let currentUrl: string | null = null;
  /** The set the loop wants next; adopted once it holds at least one frame. */
  let pending: FrameSet | null = null;
  let wantKey = "";
  let debounce: number | undefined;

  const tick = () => {
    const { width: cssW, height: cssH } = size();
    const m = model();
    if (cssW <= 0 || cssH <= 0 || m.url === null) return;
    const url = m.url;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(2048, Math.max(1, Math.round(cssW * dpr)));
    const height = Math.min(2048, Math.max(1, Math.round(cssH * dpr)));
    const key = `${url}|${width}|${height}|${dpr}`;
    if (key !== wantKey) {
      wantKey = key;
      window.clearTimeout(debounce);
      const go = () => {
        pending = requestSet(key, url, cssW, cssH, dpr, width, height);
      };
      // A URL change (or the first frame) encodes at once; a size change is
      // debounced so a drag-resize does not encode 32 frames per pixel. Until
      // the new set has a frame the previous one keeps painting — the canvas
      // stretches whatever it gets, so a stale-size frame still fills the pane.
      if (current === null || url !== currentUrl) go();
      else debounce = window.setTimeout(go, SIZE_DEBOUNCE_MS);
    }
    if (pending !== null && (pending.page.length > 0 || pending.loading.length > 0)) {
      current = pending;
      currentUrl = url;
      pending = null;
    }
    if (current === null) return;
    const { page, loading } = current;
    let jpeg: Uint8Array<ArrayBuffer> | undefined;
    if (m.loading && loading.length > 0) {
      jpeg = loading[Math.min(loading.length - 1, Math.floor(((performance.now() - m.loadingSince) / LOADING_MS) * LOADING_FRAMES))];
    } else if (page.length > 0) {
      jpeg = page[seq % page.length];
    } else {
      jpeg = loading[loading.length - 1]; // page frames still encoding: hold the last loading frame
    }
    if (jpeg === undefined) return;
    const frame: FakeFrame = { seq: seq++, jpeg, width: current.width, height: current.height };
    latestFrame.set(tabId, frame);
    onFrame(frame);
  };

  const interval = window.setInterval(tick, 1000 / fps);
  return () => {
    window.clearInterval(interval);
    window.clearTimeout(debounce);
  };
}
