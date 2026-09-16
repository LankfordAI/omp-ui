import {
  BROWSER_PANE_ACTING_MS,
  BROWSER_PANE_DEFAULT_VIEWPORT,
  BROWSER_PANE_FPS,
  BROWSER_PANE_FRAME_HEADER_BYTES,
  BROWSER_PANE_JPEG_QUALITY,
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

export interface BrowserPaneHostDeps {
  send: (channel: string, ...args: unknown[]) => void;
  /** Default: the Electron-backed factory; tests pass a fake. */
  createPane?: CreatePane;
  /** Display scale of the app window; clamped to BROWSER_PANE_MAX_DSF. Default () => 1. */
  displayScaleFactor?: () => number;
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
  sinks: Set<string>;
  cached: Uint8Array | null;
  header: BrowserPaneFrameHeader | null;
  size: { width: number; height: number };
  dsf: number;
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
    sinks: new Set(),
    cached: null,
    header: null,
    size: { ...BROWSER_PANE_DEFAULT_VIEWPORT },
    dsf: 1,
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
 * The scale a frame was really painted at. Wayland ignores
 * `offscreen.deviceScaleFactor`, so the requested dsf is a hypothesis the first
 * frame confirms or refutes: adopt the ratio when it is (within 2 %) the
 * requested scale or 1; a frame caught mid-resize matches neither and keeps
 * the last known scale.
 */
function paintedScale(paintedWidth: number, cssWidth: number, requested: number): number {
  if (cssWidth <= 0) return requested;
  const ratio = paintedWidth / cssWidth;
  if (Math.abs(ratio - requested) <= requested * 0.02) return requested;
  if (Math.abs(ratio - 1) <= 0.02) return 1;
  return requested;
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
  private readonly displayScaleFactor: () => number;
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
    this.displayScaleFactor = deps.displayScaleFactor ?? (() => 1);
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
    const entry = this.entry(tabId);
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

  /** tab:viewed mirror: a client viewing another tab or null leaves every other tab's sink set. */
  noteViewed(clientId: string, tabId: string | null): void {
    for (const [id, entry] of this.entries) {
      if (id === tabId) continue;
      if (entry.sinks.delete(clientId) && entry.sinks.size === 0) this.stopPainting(entry);
    }
  }

  resize(tabId: string, width: number, height: number): void {
    const entry = this.entry(tabId);
    entry.size = { width: clampViewport(width), height: clampViewport(height) };
    clearTimeout(entry.resizeTimer);
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = undefined;
      entry.pane?.setContentSize(entry.size.width, entry.size.height);
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
    const entry = this.entry(tabId);
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
          void pane.loadURL(nav.url).catch(() => {});
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
    entry.dsf = Math.min(this.displayScaleFactor(), BROWSER_PANE_MAX_DSF);
    let pane: PaneContents;
    try {
      const createPane = await this.factory();
      pane = await createPane({
        partition: BROWSER_PANE_PARTITION,
        deviceScaleFactor: entry.dsf,
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
      pane.on("did-start-loading", () => this.emitState(tabId, entry)),
      pane.on("did-stop-loading", () => this.emitState(tabId, entry)),
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
    if (entry.sinks.size > 0) this.startPainting(entry, pane);
    else pane.stopPainting();
    // A remembered URL the guard now cancels rejects here; the state still emits.
    void pane.loadURL(entry.lastUrl ?? "about:blank").catch(() => {});
    this.emitState(tabId, entry);
    return pane;
  }

  /**
   * A committed error page for a refused URL (the request layer cancelled an
   * agent's Page.navigate) must not become the URL a recreated pane reloads.
   */
  private noteCommitted(tabId: string, entry: PaneEntry, pane: PaneContents): void {
    const url = pane.getURL();
    if (isAllowedBrowserPaneTopLevelUrl(url)) entry.lastUrl = url;
    this.emitState(tabId, entry);
  }

  private onPaint(tabId: string, entry: PaneEntry, image: PaintImage): void {
    const size = image.getSize();
    // Electron's first paint of a fresh window is empty; an 8-byte frame would
    // poison the cache and the ensure answer.
    if (size.width === 0 || size.height === 0) return;
    entry.dsf = paintedScale(size.width, entry.size.width, entry.dsf);
    const t0 = this.now();
    const jpeg = image.toJPEG(BROWSER_PANE_JPEG_QUALITY);
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
    entry.cdpClients = n;
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
    };
  }

  private emitState(tabId: string, entry: PaneEntry): void {
    this.send(CH.onBrowserPaneState, tabId, this.currentState(entry));
  }
}
