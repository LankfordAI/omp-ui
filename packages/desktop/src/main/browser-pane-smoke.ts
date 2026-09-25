import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, type Server } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { app, BrowserWindow, clipboard, nativeImage } from "electron";
import { WebSocket } from "ws";
import {
  BROWSER_PANE_FPS,
  CH,
  decodeBrowserPaneFrame,
  type BrowserPaneDiagnostics,
  type BrowserPaneInputEvent,
  type BrowserPaneState,
} from "@omp-ui/core";
import { keyEvents, type KeyLike } from "../renderer/src/lib/browser-pane-input";
import { BrowserPaneHost } from "./browser-pane-host";
import page from "./browser-pane-smoke-page.html?raw";
import { smokeExitCode } from "./browser-pane-smoke-verdict";
import { ClockStamper } from "./clock-stamper";

/**
 * Electron-runtime smoke of the shipped browser pane host (#519 spec 5.7, #539).
 * Second main entry; never packaged. CI runs `--once` under real Electron.
 *
 *   npm run smoke:browser-pane -w @omp-ui/desktop -- [flags]
 *
 * Flags: --size=WxH (1280x800) --dsf=N --fps=N --software --anim --url=http://…
 *        --out=DIR --keys=<string> --no-input-test --once
 * Chromium switches pass through (`--ozone-platform=x11`, `--no-sandbox`).
 * `--once` writes the summary and exits: 0 pass, 2 listener, 3 paint,
 * 4 input, 5 watchdog. Interactive mode finishes on `q` + Enter.
 *
 * The metrics-* steps measure what the host streams, not what JS reports.
 * metrics-raster reads a 100 CSS px marker out of the newest frame and expects
 * 100 × dsf pixels. metrics-agent-viewport / metrics-clip-screenshot clobber the
 * host's emulation the way an agent does and expect layout, dpr and marker back
 * within the re-assert debounce; metrics-plain-screenshot expects them to
 * survive a capture that touches no emulation (#630); those three need --dsf>1.
 * metrics-agent-clip-region and metrics-agent-fullpage capture through the real
 * bridge and expect the named region at css × dsf pixels (#646).
 *
 * clock-stamp turns the browser clock on and expects the real stamper page to
 * change only the top-right quadrant of a PNG screenshot, and to grow a clip
 * too small for the stamp.
 */

const TAB = "smoke";
const SINK = "sink";
const DEFAULT_KEYS = "Hello 42";
const LATENCY_TIMEOUT_MS = 2_000;
const LOAD_TIMEOUT_MS = 15_000;
const ONCE_WATCHDOG_MS = 120_000;

// ---------------------------------------------------------------- flags

function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === null || hit === undefined ? null : hit.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const sizeFlag = (flagValue("size") ?? "1280x800").split("x").map(Number);
const dsfFlag = flagValue("dsf");
const flags = {
  size: { width: sizeFlag[0] ?? 1280, height: sizeFlag[1] ?? 800 },
  dsf: dsfFlag === null ? null : Number(dsfFlag),
  /** Informational: the shipped host paints at BROWSER_PANE_FPS regardless. */
  fps: Number(flagValue("fps") ?? BROWSER_PANE_FPS),
  software: hasFlag("software"),
  anim: hasFlag("anim"),
  url: flagValue("url"),
  out: resolve(flagValue("out") ?? join(__dirname, "..", "browser-pane-smoke")),
  keys: flagValue("keys") ?? DEFAULT_KEYS,
  inputTest: !hasFlag("no-input-test"),
  once: hasFlag("once"),
};

if (flags.software) app.disableHardwareAcceleration();

// ---------------------------------------------------------------- helpers

// Promises use the executor form (not Promise.withResolvers): the node tsconfig
// lib is ES2022, same convention as live-entry.ts.

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return round2(sorted[idx] as number);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, key: string): string | null {
  const v = isObject(value) ? value[key] : undefined;
  return typeof v === "string" ? v : null;
}

function isJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return (
    n > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9
  );
}

/** One `GET`; resolves to the response status once the body is drained. */
function getStatus(url: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    httpGet(url, (res) => {
      res.resume();
      res.on("end", () => resolvePromise(res.statusCode ?? 0));
    }).on("error", reject);
  });
}

/** Attempts a ws upgrade and reports whether the server refused it before `open`. */
function upgradeRejected(url: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      ws.close();
      resolvePromise(false);
    });
    ws.on("error", () => resolvePromise(true));
  });
}

// ---------------------------------------------------------------- recording

interface StateRow extends BrowserPaneState {
  t: number;
}

interface InputStep {
  name: string;
  ok: boolean | null;
  latencyMs: number | null;
  detail: unknown;
}

const t0 = performance.now();
const frames = {
  count: 0,
  firstFrameIsJpeg: null as boolean | null,
  sizesSeen: [] as string[],
  lastHeader: null as { width: number; height: number; dsf: number } | null,
  encodeMs: [] as number[],
  gapMs: [] as number[],
  bytes: [] as number[],
  lastAt: null as number | null,
  /** ms since start of every frame (decodable or not); the idle step reports offsets from it. */
  at: [] as number[],
  idlePaintsIn3s: null as number | null,
  /** JPEG bytes of the newest decodable frame (the host allocates one buffer per frame). */
  lastJpeg: null as Uint8Array | null,
};
const states: StateRow[] = [];
const inputTest: InputStep[] = [];
const bridge = {
  port: null as number | null,
  tokenPathHits: 0,
  rootPathHits: 0,
  versionStatus: { tokened: null as number | null, root: null as number | null },
  tokenToRootGapMs: null as number | null,
  upgradeRejected: 0,
  debuggerDetach: null as string | null,
  appQuitLeak: null as boolean | null,
  windowsAfterDispose: null as number | null,
  quitPath: null as "q" | "signal" | "before-quit" | "once" | "watchdog" | null,
};
const warnings: string[] = [];
let dprReported: number | null = null;
let pendingLatency: { sentAt: number; resolve: (ms: number | null) => void } | null = null;
let loadWaiter: { matches: (s: BrowserPaneState) => boolean; resolve: () => void } | null = null;

function nextFrameLatency(): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const entry = {
      sentAt: performance.now(),
      resolve: (ms: number | null) => {
        clearTimeout(timer);
        resolvePromise(ms === null ? null : round2(ms));
      },
    };
    const timer = setTimeout(() => {
      if (pendingLatency === entry) pendingLatency = null;
      resolvePromise(null);
    }, LATENCY_TIMEOUT_MS);
    pendingLatency = entry;
  });
}

function waitForState(matches: (s: BrowserPaneState) => boolean, timeoutMs: number): Promise<boolean> {
  const last = states[states.length - 1];
  if (last !== undefined && matches(last)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      loadWaiter = null;
      resolvePromise(false);
    }, timeoutMs);
    loadWaiter = {
      matches,
      resolve: () => {
        clearTimeout(timer);
        loadWaiter = null;
        resolvePromise(true);
      },
    };
  });
}

let host: BrowserPaneHost;
/** The smoke's browser clock toggle; only clock-stamp turns it on. */
let clockOn = false;
const stamper = new ClockStamper();

function smokeDiagnostics(): BrowserPaneDiagnostics | null {
  return host.diagnostics().find((row) => row.tabId === TAB) ?? null;
}

function recordFrame(frame: Uint8Array): void {
  const now = performance.now();
  const decoded = decodeBrowserPaneFrame(frame);
  frames.count += 1;
  frames.at.push(round2(now - t0));
  if (decoded === null) {
    const head = Buffer.from(frame.subarray(0, 8)).toString("hex");
    warnings.push(`frame ${frames.count}: undecodable (${frame.length} bytes, header ${head})`);
    return;
  }
  const { header, jpeg } = decoded;
  if (frames.firstFrameIsJpeg === null) frames.firstFrameIsJpeg = isJpeg(jpeg);
  frames.lastHeader = header;
  frames.lastJpeg = jpeg;
  const key = `${header.width}x${header.height}@${header.dsf}`;
  if (!frames.sizesSeen.includes(key)) frames.sizesSeen.push(key);
  frames.bytes.push(jpeg.length);
  if (frames.lastAt !== null) frames.gapMs.push(now - frames.lastAt);
  frames.lastAt = now;
  const encode = smokeDiagnostics()?.lastEncodeMs;
  if (encode !== null && encode !== undefined) frames.encodeMs.push(encode);
  if (pendingLatency !== null) {
    pendingLatency.resolve(now - pendingLatency.sentAt);
    pendingLatency = null;
  }
}

function recordState(state: BrowserPaneState): void {
  states.push({ t: round2(performance.now() - t0), ...state });
  if (loadWaiter !== null && loadWaiter.matches(state)) loadWaiter.resolve();
}

function send(channel: string, ...args: unknown[]): void {
  if (channel === CH.onBrowserPaneFrame) {
    const frame = args[1];
    if (frame instanceof Uint8Array) recordFrame(frame);
    return;
  }
  if (channel === CH.onBrowserPaneState) {
    // The host's send contract (SessionManagerDependencies.send): [tabId, state].
    const state = args[1] as BrowserPaneState;
    recordState(state);
  }
}

// ---------------------------------------------------------------- our own CDP client

/** Session-level `Runtime.evaluate` value; `eval` is only handed returnByValue expressions. */
function evaluatedValue(reply: unknown): unknown {
  const exception = isObject(reply) ? reply.exceptionDetails : undefined;
  if (exception !== undefined) throw new Error(stringField(exception, "text") ?? "Runtime.evaluate threw");
  const result = isObject(reply) ? reply.result : undefined;
  return isObject(result) ? result.value : undefined;
}

/** One bridge client: proves the token path, the root Target shim, and a flattened page session. */
class SmokeCdpClient {
  readonly commands: Record<string, number> = {};
  closedByServer = false;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private closing = false;

  private constructor(
    private readonly ws: WebSocket,
    readonly openedAt: number,
  ) {
    ws.on("message", (data) => {
      const msg: unknown = JSON.parse(String(data));
      if (!isObject(msg) || typeof msg.id !== "number") return;
      const waiter = this.pending.get(msg.id);
      if (waiter === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) waiter.reject(new Error(stringField(msg.error, "message") ?? "CDP error"));
      else waiter.resolve(msg.result);
    });
    ws.on("close", () => {
      if (!this.closing) this.closedByServer = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error("bridge closed the socket"));
      this.pending.clear();
    });
  }

  static open(wsUrl: string): Promise<SmokeCdpClient> {
    return new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.once("open", () => resolvePromise(new SmokeCdpClient(ws, performance.now())));
      ws.once("error", reject);
    });
  }

  call(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    this.commands[method] = (this.commands[method] ?? 0) + 1;
    const id = this.nextId++;
    const frame: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) frame.sessionId = sessionId;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.ws.send(JSON.stringify(frame));
    });
  }

  close(): Promise<void> {
    this.closing = true;
    return new Promise((resolvePromise) => {
      this.ws.once("close", () => resolvePromise());
      this.ws.close();
    });
  }
}

interface PageReader {
  client: SmokeCdpClient;
  sessionId: string;
  /** Evaluates `expression` in the page and returns its by-value result; T is the caller's claim. */
  eval<T>(expression: string): Promise<T>;
}

async function openPageReader(cdpUrl: string): Promise<PageReader> {
  const client = await SmokeCdpClient.open(cdpUrl.replace(/^http/, "ws"));
  const targets = await client.call("Target.getTargets");
  const infos = isObject(targets) && Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
  const pageId = infos.map((t) => (stringField(t, "type") === "page" ? stringField(t, "targetId") : null)).find((id) => id !== null);
  if (pageId === undefined || pageId === null) throw new Error("the bridge exposes no page target");
  const attached = await client.call("Target.attachToTarget", { targetId: pageId, flatten: true });
  const sessionId = stringField(attached, "sessionId");
  if (sessionId === null) throw new Error("Target.attachToTarget returned no sessionId");
  return {
    client,
    sessionId,
    async eval<T>(expression: string): Promise<T> {
      const reply = await client.call(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      // The page is our own test page; each expression's value shape is known at the call site.
      const value = evaluatedValue(reply) as T;
      return value;
    },
  };
}

// ---------------------------------------------------------------- input self-test

function input(event: BrowserPaneInputEvent): void {
  host.input(TAB, event);
}

async function clickAt(x: number, y: number, button: "left" | "right" = "left"): Promise<number | null> {
  input({ type: "mouseMove", x, y });
  await sleep(50);
  const latency = nextFrameLatency();
  input({ type: "mouseDown", x, y, button, clickCount: 1 });
  input({ type: "mouseUp", x, y, button, clickCount: 1 });
  return latency;
}

function recordStep(name: string, ok: boolean | null, detail: unknown, latencyMs: number | null): void {
  inputTest.push({ name, ok, latencyMs, detail });
  console.log(`INPUT ${name} ok=${ok} latencyMs=${latencyMs} detail=${JSON.stringify(detail)}`);
}

function keyLike(key: string, overrides: Partial<KeyLike> = {}): KeyLike {
  return {
    key,
    shiftKey: key !== key.toLowerCase(),
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    capsLock: false,
    altGraph: false,
    location: 0,
    isComposing: false,
    ...overrides,
  };
}

async function center(reader: PageReader, selector: string): Promise<{ x: number; y: number }> {
  const [x, y] = await reader.eval<[number, number]>(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
  );
  return { x: Math.round(x), y: Math.round(y) };
}

type DomEvent = [string, string, string];

async function runDomSteps(reader: PageReader): Promise<void> {
  const darwin = process.platform === "darwin";
  const inputValue = (): Promise<string> => reader.eval<string>("document.querySelector('#input').value");

  const btn = await center(reader, "#btn");
  let latency = await clickAt(btn.x, btn.y);
  await sleep(100);
  let events = await reader.eval<DomEvent[]>("window.__events");
  const out = await reader.eval<string>("document.querySelector('#out').textContent");
  recordStep(
    "click-button",
    events.some((e) => e[0] === "click" && e[1] === "btn") && out.startsWith("clicks=1"),
    { out, events: events.length },
    latency,
  );

  const field = await center(reader, "#input");
  await clickAt(field.x, field.y);
  await sleep(100);
  let pending = nextFrameLatency();
  for (const keyCode of "user") {
    input({ type: "keyDown", keyCode });
    input({ type: "char", keyCode });
    input({ type: "keyUp", keyCode });
  }
  let value = await inputValue();
  recordStep("type-keys", value === "user", { value }, await pending);

  pending = nextFrameLatency();
  input({ type: "insertText", text: "한🙂" });
  await sleep(100);
  value = await inputValue();
  recordStep("insert-text", value === "user한🙂", { value }, await pending);

  // Live preedit (#541): the commit replaces it rather than appending.
  pending = nextFrameLatency();
  input({ type: "imeSetComposition", text: "ㅎ", selectionStart: 1, selectionEnd: 1 });
  await sleep(80);
  const preedit = await inputValue();
  input({ type: "imeSetComposition", text: "한", selectionStart: 1, selectionEnd: 1 });
  await sleep(80);
  input({ type: "insertText", text: "한" });
  await sleep(100);
  value = await inputValue();
  recordStep("ime-composition", preedit === "user한🙂ㅎ" && value === "user한🙂한", { preedit, value }, await pending);

  const mid = { x: Math.round(flags.size.width / 2), y: Math.round(flags.size.height / 2) };
  pending = nextFrameLatency();
  input({ type: "mouseWheel", x: mid.x, y: mid.y, deltaX: 0, deltaY: -120, hasPreciseScrollingDeltas: true });
  await sleep(250);
  const scrollY = await reader.eval<number>("window.scrollY");
  recordStep("wheel", scrollY > 0, { scrollY, deltaY: -120 }, await pending);

  // The wheel step scrolled #btn out of the viewport.
  await reader.eval("window.scrollTo(0, 0)");
  await sleep(100);
  const btnAgain = await center(reader, "#btn");
  latency = await clickAt(btnAgain.x, btnAgain.y, "right");
  await sleep(100);
  events = await reader.eval<DomEvent[]>("window.__events");
  recordStep(
    "right-click",
    events.some((e) => e[0] === "contextmenu" && e[1] === "btn"),
    { domEvents: events.slice(-3) },
    latency,
  );

  // --keys through the renderer's translation table, exactly as the canvas would send them.
  await reader.eval("document.querySelector('#input').value = ''");
  await clickAt(field.x, field.y);
  await sleep(100);
  pending = nextFrameLatency();
  let translated = 0;
  for (const key of flags.keys) {
    const like = keyLike(key);
    for (const event of keyEvents("keydown", like, { darwin }).events) {
      translated += 1;
      input(event);
    }
    for (const event of keyEvents("keyup", like, { darwin }).events) {
      translated += 1;
      input(event);
    }
  }
  await sleep(100);
  value = await inputValue();
  recordStep("keys", value === flags.keys, { keys: flags.keys, value, events: translated }, await pending);

  if (darwin) {
    const selectAll = keyEvents("keydown", keyLike("a", { metaKey: true }), { darwin }).events;
    for (const event of selectAll) input(event);
    await sleep(100);
    const selected = await reader.eval<string>(
      "(() => { const i = document.querySelector('#input'); return i.value.slice(i.selectionStart, i.selectionEnd); })()",
    );
    recordStep("meta-select-all", selected === flags.keys, { selected, events: selectAll }, null);

    clipboard.writeText("pasted");
    const paste = keyEvents("keydown", keyLike("v", { metaKey: true }), { darwin }).events;
    pending = nextFrameLatency();
    for (const event of paste) input(event);
    await sleep(150);
    value = await inputValue();
    recordStep("meta-paste", value === "pasted", { value, events: paste }, await pending);
  } else {
    recordStep("meta-select-all", null, "darwin only", null);
    recordStep("meta-paste", null, "darwin only", null);
  }
}

/** Debounce (250 ms) + resize + paint: how long a clobbered pin needs to come back. */
const METRICS_SETTLE_MS = 600;

const MARKER_CSS = 100;

/** Frame px width of a 100 CSS px red marker pinned at the viewport's top-left, read from the host's newest frame. */
async function markerFramePx(reader: PageReader): Promise<number | null> {
  // Toggling the shade forces a repaint even when the marker already exists.
  await reader.eval(
    `(() => { let m = document.getElementById("smoke-marker"); if (m === null) { m = document.createElement("div"); m.id = "smoke-marker"; document.body.appendChild(m); } const shade = m.style.background === "rgb(255, 0, 0)" ? "rgb(254, 0, 0)" : "rgb(255, 0, 0)"; m.style.cssText = "position:fixed;left:0;top:0;width:${MARKER_CSS}px;height:${MARKER_CSS}px;z-index:2147483647;background:" + shade; return true; })()`,
  );
  await nextFrameLatency();
  const jpeg = frames.lastJpeg;
  if (jpeg === null) return null;
  const image = nativeImage.createFromBuffer(Buffer.from(jpeg));
  const { width } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  let run = 0;
  for (let x = 0; x < width; x += 1) {
    const at = (4 * width + x) * 4; // row 4: inside the marker, clear of the frame edge
    const red = bitmap.readUInt8(at + 2) > 200 && bitmap.readUInt8(at + 1) < 90 && bitmap.readUInt8(at) < 90;
    if (!red) break;
    run += 1;
  }
  return run;
}

function rasterMatches(px: number | null, dsf: number): boolean {
  return px !== null && Math.abs(px - MARKER_CSS * dsf) <= 3;
}

/** What the page and the newest frame report about the host's geometry. */
interface MetricsRead {
  dpr: number;
  inner: number[];
  markerPx: number | null;
  lastHeader: { width: number; height: number; dsf: number } | null;
}

/**
 * Agent CDP traffic that overwrites or disables the widget's device emulation
 * (#630): a puppeteer viewport and a clipped screenshot. Each must leave the
 * page back at the host's CSS size, dsf and raster once the re-assert has
 * landed; a plain screenshot must leave the pin alone. metrics-raster first
 * proves the page really rasterizes at dsf (#646), and the agent-capture steps
 * check that the bridge maps an agent's screenshot clips by the page zoom.
 */
async function runMetricsClobberSteps(reader: PageReader): Promise<void> {
  const wantDsf = flags.dsf ?? 1;
  const want = { dpr: wantDsf, inner: [flags.size.width, flags.size.height], markerPx: MARKER_CSS * wantDsf };
  const readMetrics = async (): Promise<MetricsRead> => {
    const [dpr, w, h] = await reader.eval<[number, number, number]>("[devicePixelRatio, innerWidth, innerHeight]");
    return { dpr, inner: [w, h], markerPx: await markerFramePx(reader), lastHeader: frames.lastHeader };
  };
  /** Layout, dpr and rasterization all back at the host's values. */
  const pinned = (got: MetricsRead): boolean =>
    got.dpr === wantDsf && got.inner[0] === want.inner[0] && got.inner[1] === want.inner[1] && rasterMatches(got.markerPx, wantDsf);

  // The page fills its frame and rasterizes at dsf: at 1 this still proves the
  // marker spans the whole CSS viewport, not a 1/dsf corner (#646).
  const rasterGot = await readMetrics();
  recordStep("metrics-raster", pinned(rasterGot), { ...rasterGot, want }, null);

  const clobbers: Array<[string, string, object]> = [
    [
      "metrics-agent-viewport",
      "Emulation.setDeviceMetricsOverride",
      { width: flags.size.width, height: flags.size.height, deviceScaleFactor: 1, mobile: false },
    ],
    [
      "metrics-clip-screenshot",
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 40,
        clip: { x: 0, y: 0, width: 64, height: 64, scale: 1 },
        captureBeyondViewport: true,
        fromSurface: true,
      },
    ],
  ];
  for (const [name, method, params] of clobbers) {
    await reader.client.call(method, params, reader.sessionId);
    await sleep(METRICS_SETTLE_MS);
    const got = await readMetrics();
    // At dsf 1 the agent's override equals the host's pin: nothing to prove.
    if (wantDsf > 1) recordStep(name, pinned(got), { ...got, want }, null);
    else recordStep(name, null, { ...got, want, note: "needs --dsf>1" }, null);
  }

  // A plain screenshot (no clip, no captureBeyondViewport) touches no emulation,
  // so the pin must survive it without any re-assert. The offscreen capture
  // itself forces compositor frames (measured: 3-4 paints on Linux), so the
  // paint count is recorded, not gated.
  const before = frames.count;
  const windowStart = performance.now() - t0;
  await reader.client.call(
    "Page.captureScreenshot",
    { format: "jpeg", quality: 40, captureBeyondViewport: false },
    reader.sessionId,
  );
  await sleep(METRICS_SETTLE_MS);
  const got = await readMetrics();
  recordStep(
    "metrics-plain-screenshot",
    wantDsf > 1 ? pinned(got) : null,
    {
      ...got,
      want,
      ...(wantDsf > 1 ? {} : { note: "needs --dsf>1" }),
      repaints: frames.count - before,
      paintOffsetsMs: frames.at.slice(before).map((at) => round2(at - windowStart)),
    },
    null,
  );

  await runAgentCaptureSteps(reader, wantDsf);
  await reader.eval('(document.getElementById("smoke-marker")?.remove(), true)');
}

function greenPixel(bitmap: Buffer, width: number, x: number, y: number): boolean {
  const at = (y * width + x) * 4; // BGRA
  return bitmap.readUInt8(at + 1) > 150 && bitmap.readUInt8(at + 2) < 80 && bitmap.readUInt8(at) < 80;
}

/**
 * Screenshots through the real bridge (#646): a client's CSS clip must come
 * back as that region at css × dsf pixels, and a clipless captureBeyondViewport
 * (puppeteer fullPage) as the whole CSS content at the same density.
 */
async function runAgentCaptureSteps(reader: PageReader, dsf: number): Promise<void> {
  const capture = async (params: object): Promise<Electron.NativeImage> => {
    const reply = await reader.client.call("Page.captureScreenshot", params, reader.sessionId);
    const data = stringField(reply, "data");
    if (data === null) throw new Error("Page.captureScreenshot returned no data");
    return nativeImage.createFromBuffer(Buffer.from(data, "base64"));
  };
  await reader.eval(
    '(() => { let p = document.getElementById("smoke-probe"); if (p === null) { p = document.createElement("div"); p.id = "smoke-probe"; document.body.appendChild(p); } p.style.cssText = "position:absolute;left:300px;top:200px;width:40px;height:40px;background:rgb(0,200,0);z-index:2147483647"; window.scrollTo(0, 0); return true; })()',
  );
  try {
    const region = await capture({
      format: "png",
      clip: { x: 300, y: 200, width: 40, height: 40, scale: 1 },
      captureBeyondViewport: true,
      fromSurface: true,
    });
    const regionSize = region.getSize();
    const wantRegion = Math.round(40 * dsf);
    recordStep(
      "metrics-agent-clip-region",
      Math.abs(regionSize.width - wantRegion) <= 1 &&
        Math.abs(regionSize.height - wantRegion) <= 1 &&
        greenPixel(region.toBitmap(), regionSize.width, Math.floor(regionSize.width / 2), Math.floor(regionSize.height / 2)),
      { size: regionSize, want: wantRegion, dsf },
      null,
    );
    // The clipped capture restores the agent session's emulation; let the host re-assert land.
    await sleep(METRICS_SETTLE_MS);

    const metrics = await reader.client.call("Page.getLayoutMetrics", {}, reader.sessionId);
    const cssSize = isObject(metrics) && isObject(metrics.cssContentSize) ? metrics.cssContentSize : null;
    const cssWidth = cssSize !== null && typeof cssSize.width === "number" ? cssSize.width : null;
    const full = await capture({ format: "png", captureBeyondViewport: true, fromSurface: true });
    const fullSize = full.getSize();
    recordStep(
      "metrics-agent-fullpage",
      cssWidth !== null &&
        Math.abs(fullSize.width - cssWidth * dsf) <= 2 &&
        greenPixel(full.toBitmap(), fullSize.width, Math.round(320 * dsf), Math.round(220 * dsf)),
      { size: fullSize, cssWidth, dsf },
      null,
    );
    await sleep(METRICS_SETTLE_MS);
  } finally {
    await reader.eval('(document.getElementById("smoke-probe")?.remove(), true)');
  }
}

const CLOCK_TEXT = "Sep 23, 2026  4:19 PM CDT";

/**
 * The browser clock through the real bridge, ClockStamper page, and encoder:
 * the same PNG capture with the clock off and on must differ only in the
 * top-right quadrant, and a 40x20 clip must come back taller than it was
 * asked for (the stamp needs more room than the clip has).
 */
async function runClockStampStep(reader: PageReader): Promise<void> {
  const dsf = flags.dsf ?? 1;
  const capture = async (params: object): Promise<Electron.NativeImage> => {
    const reply = await reader.client.call("Page.captureScreenshot", params, reader.sessionId);
    const data = stringField(reply, "data");
    if (data === null) throw new Error("Page.captureScreenshot returned no data");
    return nativeImage.createFromBuffer(Buffer.from(data, "base64"));
  };
  const plain = { format: "png", captureBeyondViewport: false };
  try {
    // A focused caret blinks: A and B must be captures of a still page.
    await reader.eval("document.activeElement?.blur()");
    let a = await capture(plain);
    for (let i = 0; i < 5; i += 1) {
      const again = await capture(plain);
      const stable = again.toBitmap().equals(a.toBitmap());
      a = again;
      if (stable) break;
      await sleep(200);
    }
    clockOn = true;
    const b = await capture(plain);
    const sizeA = a.getSize();
    const sizeB = b.getSize();
    let differing = 0;
    let outsideQuadrant = 0;
    if (sizeA.width === sizeB.width && sizeA.height === sizeB.height) {
      const bitmapA = a.toBitmap();
      const bitmapB = b.toBitmap();
      for (let px = 0; px < sizeA.width * sizeA.height; px += 1) {
        const at = px * 4;
        if (bitmapA.readUInt32LE(at) === bitmapB.readUInt32LE(at)) continue;
        differing += 1;
        const x = px % sizeA.width;
        const y = Math.floor(px / sizeA.width);
        if (x < sizeA.width / 2 || y >= sizeA.height / 2) outsideQuadrant += 1;
      }
    }
    const clipped = await capture({ format: "jpeg", clip: { x: 0, y: 0, width: 40, height: 20, scale: 1 } });
    const clipSize = clipped.getSize();
    // The clip clobbers the HiDPI pin; let the re-assert land before later steps.
    await sleep(METRICS_SETTLE_MS);
    const ok =
      sizeA.width === sizeB.width &&
      sizeA.height === sizeB.height &&
      differing > 0 &&
      outsideQuadrant === 0 &&
      clipSize.height > 20 * dsf;
    recordStep("clock-stamp", ok, { sizeA, sizeB, differing, outsideQuadrant, clipSize, dsf }, null);
  } finally {
    clockOn = false;
  }
}

async function runInputTest(reader: PageReader): Promise<void> {
  await sleep(300);
  try {
    if (flags.url === null) {
      await runDomSteps(reader);
    } else {
      const mid = { x: Math.round(flags.size.width / 2), y: Math.round(flags.size.height / 2) };
      const latency = await clickAt(mid.x, mid.y);
      recordStep("click-centre", latency !== null, "external --url: DOM assertions skipped", latency);
    }
  } catch (err) {
    recordStep("self-test", false, { error: err instanceof Error ? err.message : String(err) }, null);
  }
  try {
    await runMetricsClobberSteps(reader);
  } catch (err) {
    recordStep("metrics-clobber", false, { error: err instanceof Error ? err.message : String(err) }, null);
  }
  try {
    await runClockStampStep(reader);
  } catch (err) {
    recordStep("clock-stamp", false, { error: err instanceof Error ? err.message : String(err) }, null);
  }
  // Keyboard coverage leaves a blinking caret focused, which is page-authored
  // animation rather than an idle host repaint. Remove it before measuring.
  await reader.eval("document.activeElement?.blur()");
  // Let the last step's repaints drain before the idle window opens. Without
  // --anim the pane must not repaint on its own; measured on Linux, software
  // compositing (--software) lands exactly one late paint 0.5-2.5 s after the
  // last input and is then silent, so one stray paint passes — a repaint loop
  // at BROWSER_PANE_FPS would show ~90.
  await sleep(500);
  const before = frames.count;
  const windowStart = performance.now() - t0;
  await sleep(3_000);
  frames.idlePaintsIn3s = frames.count - before;
  recordStep(
    "idle-paints",
    flags.anim ? frames.idlePaintsIn3s > 0 : frames.idlePaintsIn3s <= 1,
    {
      idlePaintsIn3s: frames.idlePaintsIn3s,
      anim: flags.anim,
      paintOffsetsMs: frames.at.slice(before).map((at) => round2(at - windowStart)),
    },
    null,
  );
}

// ---------------------------------------------------------------- summary / exit

interface ClientRow {
  name: string;
  commands: Record<string, number>;
  connectedMs: number | null;
  closedByServer: boolean;
}
const clients: ClientRow[] = [];
let devServer: Server | null = null;
let finished = false;
let onceWatchdog: NodeJS.Timeout | undefined;
/** The host's rows as they stood before disposeAll emptied them. */
let diagnosticsBeforeDispose: BrowserPaneDiagnostics[] | null = null;

function summary(): object {
  const rows = diagnosticsBeforeDispose ?? host.diagnostics();
  const paneRow = rows.find((row) => row.tabId === TAB) ?? null;
  return {
    platform: {
      os: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      hardwareAcceleration: !flags.software,
      sandbox: !app.commandLine.hasSwitch("no-sandbox"),
      ozone:
        process.platform === "linux"
          ? app.commandLine.getSwitchValue("ozone-platform") || "auto"
          : "n/a",
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
    },
    flags,
    window: {
      size: [flags.size.width, flags.size.height],
      dsfRequested: flags.dsf ?? 1,
      dprReported,
      lastFrame: frames.lastHeader,
      targetDsf: paneRow?.targetDsf ?? null,
    },
    frames: {
      count: frames.count,
      firstFrameIsJpeg: frames.firstFrameIsJpeg,
      sizesSeen: frames.sizesSeen,
      encodeMs: { p50: percentile(frames.encodeMs, 0.5), p90: percentile(frames.encodeMs, 0.9) },
      gapMs: { p50: percentile(frames.gapMs, 0.5), p90: percentile(frames.gapMs, 0.9) },
      bytes: { p50: percentile(frames.bytes, 0.5) },
      idlePaintsIn3s: frames.idlePaintsIn3s,
      uptimeS: round2((performance.now() - t0) / 1000),
    },
    inputTest,
    bridge,
    clients,
    diagnostics: rows,
    warnings,
  };
}

function writeSummary(): string {
  mkdirSync(flags.out, { recursive: true });
  const file = join(flags.out, "summary.json");
  writeFileSync(file, `${JSON.stringify(summary(), null, 2)}\n`);
  return file;
}

function finish(path: NonNullable<typeof bridge.quitPath>): void {
  if (finished) return;
  clearTimeout(onceWatchdog);
  finished = true;
  bridge.quitPath = path;
  diagnosticsBeforeDispose = host.diagnostics();
  host.disposeAll();
  stamper.dispose();
  bridge.appQuitLeak = host.diagnostics().some((row) => row.pageAlive);
  bridge.windowsAfterDispose = BrowserWindow.getAllWindows().length;
  devServer?.close();
  const file = writeSummary();
  console.log(`FINISH via=${path} appQuitLeak=${bridge.appQuitLeak} summary=${file}`);
  if (flags.once) {
    app.exit(smokeExitCode({
      frames: { count: frames.count, firstFrameIsJpeg: frames.firstFrameIsJpeg },
      inputTest,
      quitPath: bridge.quitPath,
    }));
  } else {
    app.quit();
  }
}

app.on("before-quit", () => finish("before-quit"));
// A listener disables Electron's default quit-on-last-window so the pane's
// disposal (or an unexpected death) never ends the run without a summary.
app.on("window-all-closed", () => {
  if (!finished) warnings.push("window-all-closed fired before finish");
});
process.on("SIGINT", () => finish("signal"));
process.on("SIGTERM", () => finish("signal"));

function startDevServer(): Promise<string> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      devServer = server;
      resolvePromise(`http://127.0.0.1:${port}/${flags.anim ? "?anim=1" : ""}`);
    });
  });
}

async function checkBridgeHttp(cdpUrl: string): Promise<void> {
  const origin = new URL(cdpUrl).origin;
  const tokenAt = performance.now();
  const tokened = await getStatus(`${cdpUrl}/json/version`);
  bridge.versionStatus.tokened = tokened;
  if (tokened === 200) bridge.tokenPathHits += 1;
  const rootAt = performance.now();
  const root = await getStatus(`${origin}/json/version`);
  bridge.versionStatus.root = root;
  bridge.tokenToRootGapMs = round2(rootAt - tokenAt);
  if (root === 200) bridge.rootPathHits += 1;
  if (await upgradeRejected(`${origin.replace(/^http/, "ws")}/not-the-token`)) bridge.upgradeRejected += 1;
  console.log(
    `BRIDGE /json/version tokened=${tokened} root=${root} gapMs=${bridge.tokenToRootGapMs} wrongPathUpgradeRejected=${bridge.upgradeRejected === 1}`,
  );
}

async function main(): Promise<void> {
  if (flags.once) {
    onceWatchdog = setTimeout(() => {
      warnings.push("once: watchdog fired before the self-test finished");
      finish("watchdog");
    }, ONCE_WATCHDOG_MS);
  }
  if (flags.fps !== BROWSER_PANE_FPS) {
    warnings.push(`--fps=${flags.fps} is informational: the shipped host paints at BROWSER_PANE_FPS=${BROWSER_PANE_FPS}`);
  }
  const devUrl = flags.url ?? (await startDevServer());
  host = new BrowserPaneHost({
    send,
    targetScaleFactor: () => flags.dsf ?? 1,
    warn: (message) => {
      warnings.push(message);
      console.warn(message);
    },
    clockEnabled: () => clockOn,
    clockText: () => CLOCK_TEXT,
    stampImage: (req) => stamper.stamp(req),
  });
  const cdpUrl = await host.ensureEndpoint(TAB);
  if (cdpUrl === null) {
    console.error("FATAL: the bridge listener failed; see warnings");
    writeSummary();
    app.exit(2);
    return;
  }
  bridge.port = new URL(cdpUrl).port === "" ? null : Number(new URL(cdpUrl).port);
  console.log(`READY cdp_url=${cdpUrl} dev_url=${devUrl} out=${flags.out}`);

  host.subscribe(TAB, SINK, true);
  host.resize(TAB, flags.size.width, flags.size.height);
  const loaded = waitForState((s) => s.alive && !s.loading && s.url !== null && s.url.startsWith(devUrl), LOAD_TIMEOUT_MS);
  host.navigate(TAB, { action: "goto", url: devUrl });
  if (!(await loaded)) recordStep("load", false, { devUrl, lastState: states[states.length - 1] ?? null }, null);

  await checkBridgeHttp(cdpUrl);

  const reader = await openPageReader(cdpUrl);
  const row: ClientRow = { name: "smoke-self-test", commands: reader.client.commands, connectedMs: null, closedByServer: false };
  clients.push(row);
  try {
    dprReported = await reader.eval<number>("devicePixelRatio");
    if (flags.inputTest) await runInputTest(reader);
  } catch (err) {
    recordStep("self-test", false, { error: err instanceof Error ? err.message : String(err) }, null);
  }
  row.closedByServer = reader.client.closedByServer;
  if (row.closedByServer) bridge.debuggerDetach = "bridge closed the self-test client";
  await reader.client.close();
  row.connectedMs = round2(performance.now() - reader.client.openedAt);

  writeSummary();
  console.log(
    `SELF-TEST DONE frames=${frames.count} dpr=${dprReported} agentStates=${[...new Set(states.map((s) => s.agent))].join(">")}`,
  );
  if (flags.once) {
    finish("once");
    return;
  }
  console.log("type q + Enter to finish");

  let lastCount = frames.count;
  setInterval(() => {
    const fps5 = (frames.count - lastCount) / 5;
    lastCount = frames.count;
    const diag = smokeDiagnostics();
    console.log(
      `STATUS frames=${frames.count} fps(5s)=${fps5.toFixed(1)} encodeMs p50/p90=${percentile(frames.encodeMs, 0.5)}/${percentile(frames.encodeMs, 0.9)} bytes p50=${percentile(frames.bytes, 0.5)} cdpClients=${diag?.cdpClients ?? 0} agent=${diag?.agentState ?? "-"}`,
    );
  }, 5_000);

  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() === "q") finish("q");
  });
}

void app.whenReady().then(main);
