import {
  BROWSER_PANE_ACTING_MS,
  BROWSER_PANE_DEFAULT_VIEWPORT,
  BROWSER_PANE_FPS,
  BROWSER_PANE_FRAME_HEADER_BYTES,
  BROWSER_PANE_JPEG_QUALITY,
  BROWSER_PANE_JPEG_QUALITY_SETTLED,
  BROWSER_PANE_MAX_DSF,
  BROWSER_PANE_MAX_VIEWPORT,
  BROWSER_PANE_MIN_VIEWPORT,
  BROWSER_PANE_PARTITION,
  BROWSER_PANE_RESIZE_DEBOUNCE_MS,
  CH,
  encodeBrowserPaneFrameHeader,
  isAllowedBrowserPaneTopLevelUrl,
  type BrowserPaneAgentState,
  type BrowserPaneDiagnostics,
  type BrowserPaneEnsureResult,
  type BrowserPaneFrameHeader,
  type BrowserPaneInputEvent,
  type BrowserPanePickResult,
  type BrowserPaneNavigate,
  type BrowserPaneState,
} from "@omp-ui/core";
import { mintRemoteToken } from "@omp-ui/server";
import {
  createBridgeListener,
  type BridgeListener,
  type CreateBridgeListener,
} from "./browser-pane-bridge";
import type { CreatePane, PaneContents, PaintImage } from "./browser-pane-contents";
import { pickElement } from "./browser-pane-pick";

/**
 * One browser pane per tab (#519, ADR-0029): the offscreen page, its JPEG
 * frame fan-out to subscribed clients, the loopback CDP bridge the agent
 * drives it through, and the agent-state derivation the renderer shows. The
 * page is Electron-free behind `PaneContents`; the default factory is loaded
 * lazily so this module (and SessionManager) import no Electron.
 */

/** Client commands that mean the agent is steering the page right now (#530). */
const ACTING_COMMAND_RE = /^Input\.|^Page\.navigate$|^Runtime\.(evaluate|callFunctionOn)$/;
const FPS_EWMA_ALPHA = 0.2;
/**
 * Agent commands after which the widget's device emulation may no longer be the
 * host's: a puppeteer viewport (Emulation.*), or a Page.captureScreenshot whose
 * clip / captureBeyondViewport makes Chromium install and then "restore" the
 * agent session's own (empty) emulation params — a DisableDeviceEmulation on the
 * widget that no Emulation.* command ever announces (#630).
 */
function clobbersMetrics(method: string, params: object): boolean {
  if (/^Emulation\.(set|clear)DeviceMetricsOverride$/.test(method)) return true;
  if (method !== "Page.captureScreenshot") return false;
  const p = params as { clip?: unknown; captureBeyondViewport?: unknown };
  return (typeof p.clip === "object" && p.clip !== null) || p.captureBeyondViewport === true;
}
/** How long after the last clobbering agent command the host re-asserts its own geometry. */
const METRICS_REASSERT_MS = 250;

export interface BrowserPaneHostDeps {
  send: (channel: string, ...args: unknown[]) => void;
  /** Default: the Electron-backed factory; tests pass a fake. */
  createPane?: CreatePane;
  /** Effective page devicePixelRatio of the app window (1 on unknown); clamped to BROWSER_PANE_MAX_DSF. Default () => 1. */
  targetScaleFactor?: () => number;
  /** Default: the real http+ws bridge; tests may fake. */
  createListener?: CreateBridgeListener;
  now?: () => number;
  /** Default console.warn. */
  /** Default: clear the Electron partition through the pane contents seam. */
  clearPartition?: (partition: string) => Promise<void>;
  warn?: (message: string) => void;
}

interface PaneEntry {
  listener: BridgeListener | null;
  pane: PaneContents | null;
  /** Concurrent page creations share this. */
  paneInFlight: Promise<PaneContents | null> | null;
  /** Handlers to detach before the page is destroyed. */
  offPane: Array<() => void>;
  lastUrl: string | null;
  /** Session-level pane visibility (#556): open in at least one view. */
  open: boolean;
  sinks: Set<string>;
  cached: Uint8Array | null;
  header: BrowserPaneFrameHeader | null;
  size: { width: number; height: number };
  /** The dsf of the last painted frame. */
  dsf: number;
  /** The rasterization scale aimed for on this page (min of targetScaleFactor() and BROWSER_PANE_MAX_DSF). */
  targetDsf: number;
  /** Whether the offscreen window is sized css*dsf or css; only ever moves window-scaled → window-css. */
  metricsMode: "window-scaled" | "window-css";
  /** The window's first top-level document has committed; the metrics override is safe to send only then (#557). */
  documentCommitted: boolean;
  /** applyMetrics sized the window but the commit gate deferred the override. */
  metricsPending: boolean;
  reassertTimer: NodeJS.Timeout | undefined;
  agent: BrowserPaneAgentState;
  actingTimer: NodeJS.Timeout | undefined;
  cdpClients: number;
  painting: boolean;
  resizeTimer: NodeJS.Timeout | undefined;
  fps: number;
  lastPaintAt: number | null;
  lastEncodeMs: number | null;
  lastError: string | null;
}

function newEntry(lastUrl: string | null): PaneEntry {
  return {
    listener: null,
    pane: null,
    paneInFlight: null,
    offPane: [],
    lastUrl,
    open: false,
    sinks: new Set(),
    cached: null,
    header: null,
    size: { ...BROWSER_PANE_DEFAULT_VIEWPORT },
    targetDsf: 1,
    metricsMode: "window-scaled",
    dsf: 1,
    documentCommitted: false,
    metricsPending: false,
    reassertTimer: undefined,
    agent: "detached",
    actingTimer: undefined,
    cdpClients: 0,
    painting: false,
    resizeTimer: undefined,
    fps: 0,
    lastPaintAt: null,
    lastEncodeMs: null,
    lastError: null,
  };
}

function clampViewport(value: number): number {
  return Math.round(Math.min(BROWSER_PANE_MAX_VIEWPORT, Math.max(BROWSER_PANE_MIN_VIEWPORT, value)));
}

/**
 * What scale a frame was really painted at, plus whether the window came out
 * squared (a platform that auto-scales window DIPs by scaleFactor). The
 * metrics-override route sizes the offscreen window at css*dsf, which is
 * correct on Wayland but would multiply again on those platforms; the doubled
 * verdict triggers a one-shot shrink to CSS size in onPaint. A ratio of 1
 * means the override was ineffective — today's dsf-1 fallback, no regression.
 * A frame caught mid-resize matches none of them and keeps the last scale.
 */
function paintedScale(
  paintedWidth: number,
  cssWidth: number,
  target: number,
  last: number,
): { dsf: number; doubled: boolean } {
  if (cssWidth <= 0) return { dsf: last, doubled: false };
  const ratio = paintedWidth / cssWidth;
  const near = (x: number): boolean => Math.abs(ratio - x) <= x * 0.02;
  if (near(target)) return { dsf: target, doubled: false };
  if (target > 1 && near(target * target)) return { dsf: ratio, doubled: true };
  if (near(1)) return { dsf: 1, doubled: false };
  return { dsf: last, doubled: false };
}

/** `new URL(url).origin`, null for about:blank and anything unparsable. */
function safeOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export class BrowserPaneHost {
  private readonly entries = new Map<string, PaneEntry>();
  private readonly send: BrowserPaneHostDeps["send"];
  private readonly targetScaleFactor: () => number;
  private readonly createListener: CreateBridgeListener;
  private readonly now: () => number;
  private readonly clearPartition: (partition: string) => Promise<void>;
  private readonly warn: (message: string) => void;
  private paneFactory: CreatePane | null;
  private remoteAccessPort: number | null = null;
  private denied: ReadonlySet<number> = new Set();

  constructor(deps: BrowserPaneHostDeps) {
    this.send = deps.send;
    this.paneFactory = deps.createPane ?? null;
    this.targetScaleFactor = deps.targetScaleFactor ?? (() => 1);
    this.createListener = deps.createListener ?? createBridgeListener;
    this.now = deps.now ?? (() => performance.now());
    this.clearPartition = deps.clearPartition ?? (async (partition) => {
      const { clearBrowserPanePartition } = await import("./browser-pane-contents");
      await clearBrowserPanePartition(partition);
    });
    this.warn = deps.warn ?? ((message) => console.warn(message));
  }

  /** Mints the tab's loopback listener + token if absent (reused after handleExit); null and a warning when listen fails. */
  async ensureEndpoint(tabId: string): Promise<string | null> {
    const entry = this.entry(tabId);
    if (entry.listener !== null) return entry.listener.url;
    let listener: BridgeListener;
    try {
      listener = await this.createListener({
        token: mintRemoteToken(),
        onFirstClient: async () => {
          await this.ensurePage(tabId, entry);
        },
        pane: () => entry.pane,
        onClientCount: (n) => this.onClientCount(tabId, entry, n),
        onCommand: (method) => this.onCommand(tabId, entry, method),
        onCommandSettled: (method, params) => this.onCommandSettled(entry, method, params),
      });
    } catch (err) {
      entry.lastError = "listener-failed";
      this.warn(
        `[browser-pane] ${tabId}: bridge listener failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    // Disposed while listening: the entry was replaced and must not adopt this listener.
    if (this.entries.get(tabId) !== entry) {
      listener.close();
      return null;
    }
    entry.listener = listener;
    entry.lastError = null;
    this.recomputeDeniedPorts();
    return listener.url;
  }

  /** Creates the page if absent (user open or first CDP client) and answers the tail of the ladder. */
  async ensure(
    tabId: string,
  ): Promise<Extract<BrowserPaneEnsureResult, { status: "unavailable" | "available" }>> {
    const entry = this.entry(tabId);
    const pane = await this.ensurePage(tabId, entry);
    if (pane === null) return { status: "unavailable", reason: "create-failed" };
    return { status: "available", state: this.currentState(entry), frame: entry.header };
  }

  subscribe(tabId: string, clientId: string, on: boolean): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    if (!on) {
      if (entry.sinks.delete(clientId) && entry.sinks.size === 0) this.stopPainting(entry);
      return;
    }
    entry.sinks.add(clientId);
    void this.ensurePage(tabId, entry).then((pane) => {
      if (pane === null || !entry.sinks.has(clientId)) return;
      this.startPainting(entry, pane);
      if (entry.cached !== null) this.send(CH.onBrowserPaneFrame, tabId, entry.cached);
      else pane.invalidate();
    });
  }

  /**
   * Sets the session-level pane posture (#556). Painting stays bound to
   * `subscribe`, not to this flag — an open pane nobody is viewing still
   * paints nothing; the flag is purely what every viewer renders.
   */
  setOpen(tabId: string, open: boolean): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    if (entry.open === open) return;
    entry.open = open;
    this.emitState(tabId, entry);
  }

  /** tab:viewed mirror: a client viewing another tab or null leaves every other tab's sink set. */
  noteViewed(clientId: string, tabId: string | null): void {
    for (const [id, entry] of this.entries) {
      if (id === tabId) continue;
      if (entry.sinks.delete(clientId) && entry.sinks.size === 0) this.stopPainting(entry);
    }
  }

  resize(tabId: string, width: number, height: number): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    entry.size = { width: clampViewport(width), height: clampViewport(height) };
    clearTimeout(entry.resizeTimer);
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = undefined;
      const pane = entry.pane;
      if (pane !== null && !pane.isDestroyed()) this.applyMetrics(entry, pane);
    }, BROWSER_PANE_RESIZE_DEBOUNCE_MS);
  }

  /** Never blocked by agent state (#530): the user and the agent share the page. */
  input(tabId: string, event: BrowserPaneInputEvent): void {
    const entry = this.entries.get(tabId);
    const pane = entry?.pane ?? null;
    if (entry === undefined || pane === null) return;
    switch (event.type) {
      case "insertText":
        void pane.insertText(event.text).catch(() => {});
        return;
      case "imeSetComposition":
        void pane.imeSetComposition(event.text, event.selectionStart, event.selectionEnd).catch(() => {});
        return;
      case "edit":
        pane[event.command]();
        return;
      case "keyDown":
      case "keyUp":
      case "char":
        pane.sendInputEvent(event);
        return;
      default:
        pane.sendInputEvent({
          ...event,
          x: Math.min(entry.size.width, Math.max(0, event.x)),
          y: Math.min(entry.size.height, Math.max(0, event.y)),
        });
    }
  }

  navigate(tabId: string, nav: BrowserPaneNavigate): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    // Layer 1 of #531: a disallowed target is dropped and the address bar
    // snaps back to the current state.
    if (nav.action === "goto" && !isAllowedBrowserPaneTopLevelUrl(nav.url)) {
      this.emitState(tabId, entry);
      return;
    }
    void this.ensurePage(tabId, entry).then((pane) => {
      if (pane === null) return;
      switch (nav.action) {
        case "goto":
          void pane.loadURL(nav.url).catch((err: unknown) => {
            this.noteLoadFailure(tabId, entry, err);
          });
          return;
        case "back":
          if (pane.canGoBack()) pane.goBack();
          return;
        case "forward":
          if (pane.canGoForward()) pane.goForward();
          return;
        case "reload":
          pane.reload();
          return;
        case "stop":
          pane.stop();
      }
    });
  }
  /** Element under a viewport point (#544). Coordinates are clamped like input; no page is explicit. */
  async pick(tabId: string, x: number, y: number): Promise<BrowserPanePickResult> {
    const entry = this.entries.get(tabId);
    const pane = entry?.pane ?? null;
    if (entry === undefined || pane === null || pane.isDestroyed()) return { status: "no-page" };
    return pickElement(
      pane.debugger,
      Math.min(entry.size.width, Math.max(0, x)),
      Math.min(entry.size.height, Math.max(0, y)),
    );
  }


  /** Ports the page may never reach: every live bridge port plus this (#531). */
  setRemoteAccessPort(port: number | null): void {
    this.remoteAccessPort = port;
    this.recomputeDeniedPorts();
  }

  deniedPorts(): ReadonlySet<number> {
    return this.denied;
  }

  diagnostics(): BrowserPaneDiagnostics[] {
    const rows: BrowserPaneDiagnostics[] = [];
    for (const [tabId, entry] of this.entries) {
      if (entry.listener === null && entry.pane === null) continue;
      rows.push({
        tabId,
        pageAlive: entry.pane !== null && !entry.pane.isDestroyed(),
        subscribers: entry.sinks.size,
        cdpClients: entry.cdpClients,
        agentState: entry.agent,
        urlOrigin: entry.lastUrl === null ? null : safeOrigin(entry.lastUrl),
        frame: entry.header,
        targetDsf: entry.targetDsf,
        metricsMode: entry.metricsMode,
        fps: Math.round(entry.fps * 10) / 10,
        lastEncodeMs: entry.lastEncodeMs,
        bridgePort: entry.listener?.port ?? null,
        partition: BROWSER_PANE_PARTITION,
        lastError: entry.lastError,
      });
    }
    return rows;
  }
  /** Pages currently alive across every tab (#542). */
  livePageCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.pane !== null && !entry.pane.isDestroyed()) count += 1;
    }
    return count;
  }

  /** Clears the partition, recreating only pages whose views remain subscribed. */
  async clearData(): Promise<void> {
    const resubscribe: string[] = [];
    for (const [tabId, entry] of this.entries) {
      if (entry.paneInFlight !== null) await entry.paneInFlight;
      if (entry.pane === null) continue;
      this.destroyPage(entry);
      this.emitState(tabId, entry);
      if (entry.sinks.size > 0) resubscribe.push(tabId);
    }
    await this.clearPartition(BROWSER_PANE_PARTITION);
    for (const tabId of resubscribe) {
      const entry = this.entries.get(tabId);
      if (entry === undefined) continue;
      void this.ensurePage(tabId, entry).then((pane) => {
        if (pane === null || entry.sinks.size === 0) return;
        this.startPainting(entry, pane);
        pane.invalidate();
      });
    }
  }


  /** Destroys page and listener; `forgetUrl` drops the last-URL memory (delete only). */
  dispose(tabId: string, opts?: { forgetUrl?: boolean }): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    clearTimeout(entry.actingTimer);
    this.destroyPage(entry);
    const listener = entry.listener;
    entry.listener = null;
    listener?.close();
    entry.agent = "detached";
    entry.cdpClients = 0;
    // The page is gone: the session-level posture closes everywhere with it
    // (#556), matching the newEntry that replaces this one below.
    entry.open = false;
    if (opts?.forgetUrl === true) this.entries.delete(tabId);
    else this.entries.set(tabId, newEntry(entry.lastUrl));
    this.emitState(tabId, entry);
    if (listener !== null) this.recomputeDeniedPorts();
  }

  disposeAll(): void {
    for (const tabId of [...this.entries.keys()]) this.dispose(tabId);
  }

  private entry(tabId: string): PaneEntry {
    let entry = this.entries.get(tabId);
    if (entry === undefined) {
      entry = newEntry(null);
      this.entries.set(tabId, entry);
    }
    return entry;
  }

  private recomputeDeniedPorts(): void {
    const denied = new Set<number>();
    for (const entry of this.entries.values()) {
      if (entry.listener !== null) denied.add(entry.listener.port);
    }
    if (this.remoteAccessPort !== null) denied.add(this.remoteAccessPort);
    this.denied = denied;
  }

  private async factory(): Promise<CreatePane> {
    if (this.paneFactory === null) {
      // Dynamic on purpose: the default factory is the one pane module that
      // imports Electron, and SessionManager (this host's owner) must stay
      // loadable without a runtime — the PlanVerifier seam keeps the same line.
      const { makeElectronPaneFactory } = await import("./browser-pane-contents");
      this.paneFactory = makeElectronPaneFactory(() => this.denied);
    }
    return this.paneFactory;
  }

  private ensurePage(tabId: string, entry: PaneEntry): Promise<PaneContents | null> {
    if (entry.pane !== null) return Promise.resolve(entry.pane);
    if (entry.paneInFlight === null) {
      entry.paneInFlight = this.createPage(tabId, entry).finally(() => {
        entry.paneInFlight = null;
      });
    }
    return entry.paneInFlight;
  }
  private destroyPage(entry: PaneEntry): void {
    clearTimeout(entry.resizeTimer);
    entry.resizeTimer = undefined;
    clearTimeout(entry.reassertTimer);
    entry.reassertTimer = undefined;
    for (const off of entry.offPane) off();
    entry.offPane = [];
    const pane = entry.pane;
    entry.pane = null;
    entry.painting = false;
    entry.cached = null;
    entry.header = null;
    pane?.destroy();
  }


  private async createPage(tabId: string, entry: PaneEntry): Promise<PaneContents | null> {
    entry.targetDsf = Math.min(this.targetScaleFactor(), BROWSER_PANE_MAX_DSF);
    entry.dsf = 1;
    entry.documentCommitted = false;
    entry.metricsPending = false;
    let pane: PaneContents;
    try {
      const createPane = await this.factory();
      pane = await createPane({
        partition: BROWSER_PANE_PARTITION,
        width: entry.size.width,
        height: entry.size.height,
        onPopup: (url) => {
          // #529: a popup becomes an in-pane navigation through the guard;
          // only web URLs qualify (about:blank popups carry nothing).
          if (/^https?:/i.test(url)) this.navigate(tabId, { action: "goto", url });
        },
      });
    } catch (err) {
      entry.lastError = "create-failed";
      this.warn(
        `[browser-pane] ${tabId}: page creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (this.entries.get(tabId) !== entry) {
      // Disposed while the factory ran: the fresh entry must not adopt this page.
      pane.destroy();
      return null;
    }
    entry.pane = pane;
    entry.lastError = null;
    entry.offPane.push(
      pane.onPaint((_dirtyRect, image) => this.onPaint(tabId, entry, image)),
      pane.on("did-navigate", () => this.noteCommitted(tabId, entry, pane)),
      pane.on("did-navigate-in-page", () => this.noteCommitted(tabId, entry, pane)),
      pane.on("did-start-loading", () => {
        entry.lastError = null;
        this.emitState(tabId, entry);
      }),
      pane.on("did-stop-loading", () => {
        this.ensureMetrics(entry, "first-commit");
        this.emitState(tabId, entry);
      }),
      pane.on("did-fail-load", (...args) => {
        if (args[4] === false) return;
        this.noteLoadFailure(
          tabId,
          entry,
          typeof args[2] === "string" ? args[2] : "navigation failed",
        );
      }),
      pane.on("page-title-updated", () => this.emitState(tabId, entry)),
      pane.on("destroyed", () => {
        if (entry.pane !== pane) return;
        entry.pane = null;
        entry.painting = false;
        entry.offPane = [];
        this.emitState(tabId, entry);
      }),
    );
    pane.debugger.attach("1.3");
    // Size the surface and pin the CSS viewport before the first paint so the
    // page renders at target density from the start (#557).
    this.applyMetrics(entry, pane);
    if (entry.sinks.size > 0) this.startPainting(entry, pane);
    else pane.stopPainting();
    // A remembered URL the guard now cancels rejects here; the state still emits.
    void pane.loadURL(entry.lastUrl ?? "about:blank").catch((err: unknown) => {
      this.noteLoadFailure(tabId, entry, err);
    });
    this.emitState(tabId, entry);
    return pane;
  }

  /**
   * A committed error page for a refused URL (the request layer cancelled an
   * agent's Page.navigate) must not become the URL a recreated pane reloads.
   */
  private noteCommitted(tabId: string, entry: PaneEntry, pane: PaneContents): void {
    this.ensureMetrics(entry, "first-commit");
    const url = pane.getURL();
    if (isAllowedBrowserPaneTopLevelUrl(url)) entry.lastUrl = url;
    this.emitState(tabId, entry);
  }

  /**
   * Re-assert the host geometry when it may have been lost: the window's first
   * document committing (a deferred applyMetrics) or a CDP client detaching —
   * Chromium's session teardown drops the viewport emulation the detached
   * session owned (#557). The detach lands a tick after the count callback, so
   * the re-pin rides the same debounce as an agent override command.
   */
  private ensureMetrics(entry: PaneEntry, reason: "first-commit" | "client-detached"): void {
    const pane = entry.pane;
    if (pane === null || pane.isDestroyed()) return;
    if (reason === "first-commit") {
      entry.documentCommitted = true;
      if (entry.metricsPending) this.applyMetrics(entry, pane);
      return;
    }
    if (entry.documentCommitted) this.scheduleMetricsReassert(entry);
  }

  private scheduleMetricsReassert(entry: PaneEntry): void {
    clearTimeout(entry.reassertTimer);
    entry.reassertTimer = setTimeout(() => {
      entry.reassertTimer = undefined;
      const pane = entry.pane;
      if (pane !== null && !pane.isDestroyed()) this.applyMetrics(entry, pane);
    }, METRICS_REASSERT_MS);
  }

  private onPaint(tabId: string, entry: PaneEntry, image: PaintImage): void {
    const size = image.getSize();
    // Electron's first paint of a fresh window is empty; an 8-byte frame would
    // poison the cache and the ensure answer.
    if (size.width === 0 || size.height === 0) return;
    const { dsf, doubled } = paintedScale(size.width, entry.size.width, entry.targetDsf, entry.dsf);
    entry.dsf = dsf;
    if (doubled && entry.metricsMode === "window-scaled") {
      // The platform squared the scale: drop to CSS-sized windows and re-pin.
      entry.metricsMode = "window-css";
      const pane = entry.pane;
      if (pane !== null && !pane.isDestroyed()) this.applyMetrics(entry, pane);
    }
    const t0 = this.now();
    const settled = entry.pane !== null && !entry.pane.isLoading();
    const jpeg = image.toJPEG(settled ? BROWSER_PANE_JPEG_QUALITY_SETTLED : BROWSER_PANE_JPEG_QUALITY);
    const header: BrowserPaneFrameHeader = { width: size.width, height: size.height, dsf: entry.dsf };
    // One allocation per frame: header and JPEG land in the same buffer.
    const frame = Buffer.allocUnsafe(BROWSER_PANE_FRAME_HEADER_BYTES + jpeg.length);
    frame.set(encodeBrowserPaneFrameHeader(header), 0);
    frame.set(jpeg, BROWSER_PANE_FRAME_HEADER_BYTES);
    const t1 = this.now();
    entry.lastEncodeMs = t1 - t0;
    if (entry.lastPaintAt !== null && t1 > entry.lastPaintAt) {
      const instant = 1000 / (t1 - entry.lastPaintAt);
      entry.fps = entry.fps === 0 ? instant : entry.fps + FPS_EWMA_ALPHA * (instant - entry.fps);
    }
    entry.lastPaintAt = t1;
    entry.cached = frame;
    entry.header = header;
    if (entry.sinks.size > 0) this.send(CH.onBrowserPaneFrame, tabId, frame);
  }

  private startPainting(entry: PaneEntry, pane: PaneContents): void {
    if (entry.painting) return;
    entry.painting = true;
    pane.setFrameRate(BROWSER_PANE_FPS);
    pane.startPainting();
  }

  private stopPainting(entry: PaneEntry): void {
    if (!entry.painting) return;
    entry.painting = false;
    entry.pane?.stopPainting();
  }

  private onClientCount(tabId: string, entry: PaneEntry, n: number): void {
    const previous = entry.cdpClients;
    entry.cdpClients = n;
    // A detaching session runs Chromium's EmulationHandler::Disable(); if it had
    // set a viewport, the widget's emulation is gone with it (#557, #630). Every
    // decrease re-pins — the detach lands a tick after this callback, so it rides
    // the same debounce as an agent override.
    if (n < previous) this.ensureMetrics(entry, "client-detached");
    if (n > 0 && entry.agent === "detached") {
      entry.agent = "attached";
      this.emitState(tabId, entry);
    } else if (n === 0 && entry.agent !== "detached") {
      clearTimeout(entry.actingTimer);
      entry.actingTimer = undefined;
      entry.agent = "detached";
      this.emitState(tabId, entry);
    }
  }

  private onCommandSettled(entry: PaneEntry, method: string, params: object): void {
    if (clobbersMetrics(method, params)) this.scheduleMetricsReassert(entry);
  }

  private onCommand(tabId: string, entry: PaneEntry, method: string): void {
    if (!ACTING_COMMAND_RE.test(method)) return;
    clearTimeout(entry.actingTimer);
    entry.actingTimer = setTimeout(() => {
      entry.actingTimer = undefined;
      if (entry.agent !== "acting") return;
      entry.agent = "attached";
      this.emitState(tabId, entry);
    }, BROWSER_PANE_ACTING_MS);
    if (entry.agent === "acting") return;
    entry.agent = "acting";
    this.emitState(tabId, entry);
  }

  /**
   * Pin the CSS viewport at `entry.size` with deviceScaleFactor `targetDsf`
   * so paints arrive at css*dsf. Measured sequence (Electron 43/Wayland):
   * the window must sit at CSS size when the override lands, then grow —
   * growing first leaves the surface at CSS pixels, and sending the override
   * before the window's first document commits segfaults the GPU process.
   * Before that commit this only marks the entry pending; `ensureMetrics`
   * re-applies from the commit event. Until then the page paints CSS-sized at
   * dsf 1 — exactly what Wayland did before this route existed.
   *
   * Every application clears the host session's own override first: Chromium
   * ignores a re-sent identical override, so a pin another CDP session has
   * overwritten (agent `setViewport`, a clipped `Page.captureScreenshot`, a
   * detaching session) could otherwise never be restored (#630).
   */
  private applyMetrics(entry: PaneEntry, pane: PaneContents): void {
    const d = entry.targetDsf;
    const grow = entry.metricsMode === "window-scaled" ? d : 1;
    if (!entry.documentCommitted) {
      entry.metricsPending = true;
      return;
    }
    entry.metricsPending = false;
    const width = Math.min(BROWSER_PANE_MAX_VIEWPORT, Math.round(entry.size.width * grow));
    const height = Math.min(BROWSER_PANE_MAX_VIEWPORT, Math.round(entry.size.height * grow));
    // The widget's emulation is shared with every agent CDP session, and Chromium
    // drops an Emulation.setDeviceMetricsOverride whose params equal what *this*
    // session last sent — even after another session overwrote or disabled them.
    // Clearing first makes the set below always reach the renderer. Before the
    // first pin the clear is a no-op; the browser side runs at dispatch, so the
    // resize below is not raced by it.
    void pane.debugger.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
    pane.setContentSize(entry.size.width, entry.size.height);
    void pane.debugger
      .sendCommand("Emulation.setDeviceMetricsOverride", {
        width: entry.size.width,
        height: entry.size.height,
        deviceScaleFactor: d,
        mobile: false,
      })
      .then(() => {
        // Growing after the pin is what turns the dpr into surface pixels.
        if (grow > 1 && !pane.isDestroyed()) pane.setContentSize(width, height);
      })
      .catch(() => {
        // A page that refuses the override paints 1x; paintedScale records dsf 1.
      });
  }
  private noteLoadFailure(tabId: string, entry: PaneEntry, error: unknown): void {
    if (this.entries.get(tabId) !== entry) return;
    const detail = error instanceof Error ? error.message : String(error);
    entry.lastError = `load-failed: ${detail.slice(0, 500)}`;
    this.emitState(tabId, entry);
  }


  private currentState(entry: PaneEntry): BrowserPaneState {
    const pane = entry.pane;
    const alive = pane !== null && !pane.isDestroyed();
    return {
      url: entry.lastUrl,
      title: alive ? pane.getTitle() : "",
      loading: alive ? pane.isLoading() : false,
      canGoBack: alive ? pane.canGoBack() : false,
      canGoForward: alive ? pane.canGoForward() : false,
      alive,
      agent: entry.agent,
      open: entry.open,
      error: entry.lastError,
    };
  }

  private emitState(tabId: string, entry: PaneEntry): void {
    this.send(CH.onBrowserPaneState, tabId, this.currentState(entry));
  }
}
