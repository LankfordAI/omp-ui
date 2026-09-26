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
  browserClockText,
  isAllowedBrowserPaneTopLevelUrl,
  type BrowserPaneAgentState,
  type BrowserPaneDiagnostics,
  type BrowserPaneEnsureResult,
  type BrowserPaneFrameHeader,
  type BrowserPaneInputEvent,
  type BrowserPanePickResult,
  type BrowserPaneNavigate,
  type BrowserPaneState,
  type BrowserClockStampRequest,
} from "@omp-ui/core";
import { mintRemoteToken } from "@omp-ui/server";
import {
  createBridgeListener,
  type BridgeListener,
  type CreateBridgeListener,
} from "./browser-pane-bridge";
import type { CreatePane, PaneContents } from "./browser-pane-contents";
import { createBrowserPaneCapture, trimJpegToWidthHeight, type BrowserPaneCapture, type CapturedPaneFrame } from "./browser-pane-capture";
import type { DesktopMediaGeometry, DesktopMediaLease, DesktopMediaMessage } from "../browser-pane-desktop-protocol";
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
  onDesktopMedia?: (tabId: string, message: Exclude<DesktopMediaMessage, { type: "media-lease" }>) => void;
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
  /** Whether the tab's project has the browser clock on; read at every screenshot. Default () => false. */
  clockEnabled?: (tabId: string) => boolean;
  /** The stamp text for "now". Default: browserClockText(new Date(), "en"). */
  clockText?: () => string;
  /** Stamps one image (main's ClockStamper). Default rejects: no stamper wired. */
  stampImage?: (req: BrowserClockStampRequest) => Promise<string>;
  warn?: (message: string) => void;
}

interface PaneEntry {
  tabId: string;
  desktopViewers: Set<string>;
  mediaGeneration: number;
  geometry: DesktopMediaGeometry | null;
  metricsRevision: number;
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
  /** This page's zoom = rasterization scale (min of targetScaleFactor() and BROWSER_PANE_MAX_DSF), fixed at creation. */
  targetDsf: number;
  /** The window's first top-level document has committed; the metrics override is safe to send only then (#557). */
  documentCommitted: boolean;
  reassertTimer: NodeJS.Timeout | undefined;
  agent: BrowserPaneAgentState;
  actingTimer: NodeJS.Timeout | undefined;
  cdpClients: number;
  capture: BrowserPaneCapture | null;
  resizeTimer: NodeJS.Timeout | undefined;
  fps: number;
  lastFrameAt: number | null;
  lastFrameProcessMs: number | null;
  lastError: string | null;
}

function newEntry(tabId: string, lastUrl: string | null): PaneEntry {
  return {
    tabId,
    desktopViewers: new Set(),
    mediaGeneration: 0,
    geometry: null,
    metricsRevision: 0,
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
    documentCommitted: false,
    reassertTimer: undefined,
    agent: "detached",
    actingTimer: undefined,
    cdpClients: 0,
    capture: null,
    resizeTimer: undefined,
    fps: 0,
    lastFrameAt: null,
    lastFrameProcessMs: null,
    lastError: null,
  };
}

function clampViewport(value: number): number {
  return Math.round(Math.min(BROWSER_PANE_MAX_VIEWPORT, Math.max(BROWSER_PANE_MIN_VIEWPORT, value)));
}

/** The offscreen window's DIP size: the CSS viewport at the page zoom, clamped like any viewport. */
function windowSize(entry: PaneEntry): { width: number; height: number } {
  return {
    width: Math.min(BROWSER_PANE_MAX_VIEWPORT, Math.round(entry.size.width * entry.targetDsf)),
    height: Math.min(BROWSER_PANE_MAX_VIEWPORT, Math.round(entry.size.height * entry.targetDsf)),
  };
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
  private readonly clockEnabled: (tabId: string) => boolean;
  private readonly clockText: () => string;
  private readonly stampImage: (req: BrowserClockStampRequest) => Promise<string>;
  private paneFactory: CreatePane | null;
  private readonly onDesktopMedia: BrowserPaneHostDeps["onDesktopMedia"];
  private mediaGeneration = 0;
  private remoteAccessPort: number | null = null;
  private denied: ReadonlySet<number> = new Set();

  constructor(deps: BrowserPaneHostDeps) {
    this.send = deps.send;
    this.onDesktopMedia = deps.onDesktopMedia;
    this.paneFactory = deps.createPane ?? null;
    this.targetScaleFactor = deps.targetScaleFactor ?? (() => 1);
    this.createListener = deps.createListener ?? createBridgeListener;
    this.now = deps.now ?? (() => performance.now());
    this.clearPartition = deps.clearPartition ?? (async (partition) => {
      const { clearBrowserPanePartition } = await import("./browser-pane-contents");
      await clearBrowserPanePartition(partition);
    });
    this.warn = deps.warn ?? ((message) => console.warn(message));
    this.clockEnabled = deps.clockEnabled ?? (() => false);
    this.clockText = deps.clockText ?? (() => browserClockText(new Date(), "en"));
    this.stampImage =
      deps.stampImage ??
      (async () => {
        throw new Error("no clock stamper is wired");
      });
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
        transformScreenshot: (result, params) => this.stampScreenshot(tabId, entry, result, params),
        pageZoom: () => entry.targetDsf,
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
      if (entry.sinks.delete(clientId) && entry.sinks.size === 0) this.stopCapture(entry);
      return;
    }
    entry.sinks.add(clientId);
    void this.ensurePage(tabId, entry).then((pane) => {
      if (pane === null || !entry.sinks.has(clientId)) return;
      this.syncCapture(entry);
      if (entry.cached !== null) this.send(CH.onBrowserPaneFrame, tabId, entry.cached);
    });
  }

  setDesktopViewer(tabId: string, clientId: string, on: boolean): void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return;
    if (!on) {
      entry.desktopViewers.delete(clientId);
      return;
    }
    entry.desktopViewers.add(clientId);
    void this.ensurePage(tabId, entry);
    if (entry.documentCommitted && entry.geometry !== null) {
      this.onDesktopMedia?.(tabId, { type: "media-geometry", tabId, generation: entry.mediaGeneration, geometry: entry.geometry });
    }
  }

  mediaLease(tabId: string, requesterWebContentsId: number): DesktopMediaLease | null {
    const entry = this.entries.get(tabId);
    if (entry === undefined || entry.desktopViewers.size === 0 || !entry.documentCommitted ||
      entry.geometry === null || entry.pane === null || entry.pane.isDestroyed()) return null;
    try {
      return {
        sourceId: entry.pane.mediaSourceId(requesterWebContentsId),
        generation: entry.mediaGeneration,
        geometry: entry.geometry,
      };
    } catch {
      return null;
    }
  }

  /**
   * Sets the session-level pane posture (#556). Capture stays bound to
   * `subscribe`, not to this flag. An open pane nobody is viewing captures
   * nothing; the flag is purely what every viewer renders.
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
      if (entry.sinks.delete(clientId) && entry.sinks.size === 0) this.stopCapture(entry);
      entry.desktopViewers.delete(clientId);
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
      case "mouseWheel": {
        // Pane input is CSS px; the window is CSS × page zoom in DIPs (#646).
        const d = entry.targetDsf;
        pane.sendInputEvent({
          ...event,
          x: Math.min(entry.size.width, Math.max(0, event.x)) * d,
          y: Math.min(entry.size.height, Math.max(0, event.y)) * d,
          deltaX: event.deltaX * d,
          deltaY: event.deltaY * d,
        });
        return;
      }
      default: {
        const d = entry.targetDsf;
        pane.sendInputEvent({
          ...event,
          x: Math.min(entry.size.width, Math.max(0, event.x)) * d,
          y: Math.min(entry.size.height, Math.max(0, event.y)) * d,
        });
      }
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
        subscribers: entry.sinks.size + entry.desktopViewers.size,
        cdpClients: entry.cdpClients,
        agentState: entry.agent,
        urlOrigin: entry.lastUrl === null ? null : safeOrigin(entry.lastUrl),
        frame: entry.header,
        targetDsf: entry.targetDsf,
        fps: Math.round(entry.fps * 10) / 10,
        lastFrameProcessMs: entry.lastFrameProcessMs,
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
      if (entry.sinks.size > 0 || entry.desktopViewers.size > 0) resubscribe.push(tabId);
    }
    await this.clearPartition(BROWSER_PANE_PARTITION);
    for (const tabId of resubscribe) {
      const entry = this.entries.get(tabId);
      if (entry === undefined) continue;
      void this.ensurePage(tabId, entry).then((pane) => {
        if (pane === null || entry.sinks.size === 0) return;
        this.syncCapture(entry);
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
    else this.entries.set(tabId, newEntry(tabId, entry.lastUrl));
    this.emitState(tabId, entry);
    if (listener !== null) this.recomputeDeniedPorts();
  }

  disposeAll(): void {
    for (const tabId of [...this.entries.keys()]) this.dispose(tabId);
  }

  private entry(tabId: string): PaneEntry {
    let entry = this.entries.get(tabId);
    if (entry === undefined) {
      entry = newEntry(tabId, null);
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
    entry.capture?.dispose();
    entry.capture = null;
    entry.documentCommitted = false;
    entry.geometry = null;
    entry.metricsRevision += 1;
    entry.fps = 0;
    entry.lastFrameAt = null;
    entry.lastFrameProcessMs = null;
    clearTimeout(entry.resizeTimer);
    entry.resizeTimer = undefined;
    clearTimeout(entry.reassertTimer);
    entry.reassertTimer = undefined;
    for (const off of entry.offPane) off();
    entry.offPane = [];
    const pane = entry.pane;
    entry.pane = null;
    entry.cached = null;
    entry.header = null;
    if (pane !== null) {
      entry.mediaGeneration = ++this.mediaGeneration;
      this.onDesktopMedia?.(entry.tabId, { type: "media-ended", tabId: entry.tabId, generation: entry.mediaGeneration });
    }
    pane?.destroy();
  }


  private async createPage(tabId: string, entry: PaneEntry): Promise<PaneContents | null> {
    entry.targetDsf = Math.min(this.targetScaleFactor(), BROWSER_PANE_MAX_DSF);
    entry.documentCommitted = false;
    const initial = windowSize(entry);
    let pane: PaneContents;
    try {
      const createPane = await this.factory();
      pane = await createPane({
        partition: BROWSER_PANE_PARTITION,
        width: initial.width,
        height: initial.height,
        zoomFactor: entry.targetDsf,
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
    entry.mediaGeneration = ++this.mediaGeneration;
    entry.lastError = null;
    entry.offPane.push(
      pane.on("did-start-navigation", (details) => {
        const navigation = details as { isMainFrame?: boolean; isSameDocument?: boolean };
        if (!navigation.isMainFrame || navigation.isSameDocument) return;
        entry.documentCommitted = false;
        entry.geometry = null;
        entry.metricsRevision += 1;
        this.stopCapture(entry);
        entry.cached = null;
        entry.header = null;
      }),
      pane.on("did-navigate", () => this.noteCommitted(tabId, entry, pane)),
      pane.on("did-navigate-in-page", () => this.noteCommitted(tabId, entry, pane, false)),
      pane.on("did-start-loading", () => {
        entry.lastError = null;
        entry.capture?.setQuality(BROWSER_PANE_JPEG_QUALITY);
        this.emitState(tabId, entry);
      }),
      pane.on("did-stop-loading", () => {
        this.ensureMetrics(entry, "first-commit");
        entry.capture?.setQuality(BROWSER_PANE_JPEG_QUALITY_SETTLED);
        this.syncCapture(entry);
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
        this.destroyPage(entry);
        this.emitState(tabId, entry);
      }),
    );
    pane.debugger.attach("1.3");
    entry.capture = createBrowserPaneCapture(pane.debugger, {
      fps: BROWSER_PANE_FPS,
      quality: pane.isLoading() ? BROWSER_PANE_JPEG_QUALITY : BROWSER_PANE_JPEG_QUALITY_SETTLED,
      onFrame: (frame) => {
        if (entry.pane === pane) this.onFrame(tabId, entry, frame);
      },
      onError: (error) => {
        if (entry.pane !== pane) return;
        entry.lastError = `capture-failed: ${error.message.slice(0, 500)}`;
        entry.fps = 0;
        entry.lastFrameAt = null;
        this.emitState(tabId, entry);
      },
    });
    // Size the window for the current viewport; the override waits for the first commit (#557).
    this.applyMetrics(entry, pane);
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
  private noteCommitted(tabId: string, entry: PaneEntry, pane: PaneContents, restartCapture = true): void {
    if (restartCapture) this.stopCapture(entry);
    this.ensureMetrics(entry, "first-commit");
    this.syncCapture(entry);
    const url = pane.getURL();
    if (isAllowedBrowserPaneTopLevelUrl(url)) entry.lastUrl = url;
    this.emitState(tabId, entry);
  }

  /**
   * Re-assert the host geometry when it may have been lost: any document commit
   * — Chromium restores the origin's persisted zoom level at commit (#646) and
   * returns the view to CSS bounds under a pinned override (#630) — or a CDP
   * client detaching, whose session teardown drops the viewport emulation the
   * detached session owned (#557). The detach lands a tick after the count
   * callback, so the re-pin rides the same debounce as an agent override command.
   */
  private ensureMetrics(entry: PaneEntry, reason: "first-commit" | "client-detached"): void {
    const pane = entry.pane;
    if (pane === null || pane.isDestroyed()) return;
    if (reason === "first-commit") {
      entry.documentCommitted = true;
      this.applyMetrics(entry, pane);
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

  private onFrame(tabId: string, entry: PaneEntry, captured: CapturedPaneFrame): void {
    if (!entry.documentCommitted || entry.sinks.size === 0) return;
    const t0 = this.now();
    let { jpeg, width, height } = captured;
    const geometry = entry.geometry;
    if (geometry !== null && width === geometry.surfaceWidth && height === geometry.surfaceHeight &&
      (width !== geometry.width || height !== geometry.height)) {
      const trimmed = trimJpegToWidthHeight(jpeg, geometry.width, geometry.height);
      if (trimmed !== null) {
        jpeg = trimmed;
        width = geometry.width;
        height = geometry.height;
      }
    }
    const header: BrowserPaneFrameHeader = { width, height, dsf: entry.targetDsf };
    // One allocation per frame: header and JPEG land in the same buffer.
    const frame = Buffer.allocUnsafe(BROWSER_PANE_FRAME_HEADER_BYTES + jpeg.length);
    frame.set(encodeBrowserPaneFrameHeader(header), 0);
    frame.set(jpeg, BROWSER_PANE_FRAME_HEADER_BYTES);
    const t1 = this.now();
    entry.lastFrameProcessMs = captured.processMs + t1 - t0;
    if (entry.lastFrameAt !== null && t1 > entry.lastFrameAt) {
      const instant = 1000 / (t1 - entry.lastFrameAt);
      entry.fps = entry.fps === 0 ? instant : entry.fps + FPS_EWMA_ALPHA * (instant - entry.fps);
    }
    entry.lastFrameAt = t1;
    entry.cached = frame;
    entry.header = header;
    if (entry.lastError?.startsWith("capture-failed:") === true) {
      entry.lastError = null;
      this.emitState(tabId, entry);
    }
    if (entry.sinks.size > 0) this.send(CH.onBrowserPaneFrame, tabId, frame);
  }

  private syncCapture(entry: PaneEntry): void {
    entry.capture?.setEnabled(entry.documentCommitted && entry.sinks.size > 0);
  }

  private stopCapture(entry: PaneEntry): void {
    entry.capture?.setEnabled(false);
    entry.fps = 0;
    entry.lastFrameAt = null;
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

  /**
   * The browser clock's agent path: a forwarded Page.captureScreenshot result
   * gets the corner badge when the tab's project has the clock on. The image
   * keeps its format, quality and (unless the badge cannot fit) its size. The
   * badge is sized off the CSS width the image spans — the clip's, else the
   * viewport's — not off targetDsf: an agent session's capture comes back at
   * its own emulation's density, not the host's pinned dsf (#630).
   */
  private async stampScreenshot(tabId: string, entry: PaneEntry, result: unknown, params: object): Promise<unknown> {
    if (!this.clockEnabled(tabId)) return result;
    if (typeof result !== "object" || result === null) return result;
    if (!("data" in result) || typeof result.data !== "string" || result.data === "") return result;
    const data = result.data;
    // The client's raw CDP params: every field is type-checked before use.
    const p = params as { format?: unknown; quality?: unknown; clip?: { width?: unknown } | null };
    const format = p.format === "jpeg" || p.format === "webp" ? p.format : "png";
    const quality = typeof p.quality === "number" ? Math.min(100, Math.max(0, p.quality)) : null;
    const clipWidth = p.clip?.width;
    try {
      const stamped = await this.stampImage({
        data,
        mimeType: `image/${format}`,
        quality,
        text: this.clockText(),
        cssWidth: typeof clipWidth === "number" && clipWidth > 0 ? clipWidth : entry.size.width,
      });
      return { ...result, data: stamped };
    } catch (err) {
      throw new Error(
        `omp-ui browser clock: the screenshot could not be stamped (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
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

  /**
   * Size the offscreen window at css × targetDsf; the page zoom set at creation
   * lays `entry.size` CSS px out inside it and rasterizes at targetDsf (#646).
   * Then make the host the last writer of the widget's device emulation with an
   * override that reproduces exactly that state: the window size at
   * deviceScaleFactor 1, under which Blink lays out windowWidth / zoom = the CSS
   * size and reports dpr = zoom. An agent viewport, a clipped capture restoring
   * an agent session's own params, or a session detaching with a viewport would
   * otherwise leave the page at the agent's size: emulation is per CDP session
   * and a clear from this session does not drop another session's override,
   * while Chromium keeps the resized view when it drops one (#630). deviceScaleFactor 0
   * is NOT neutral: it resolves to the screen's dsf — 1.5 under Wayland fractional
   * scaling, never the offscreen view's 1 — and would then drive layout itself.
   * The override is sent only after the window's first document commits, because
   * emulation traffic earlier segfaults the GPU process (#557). It is cleared
   * first because Chromium drops a re-sent override matching what this session
   * last sent. Only after it resolves, round the compositor surface up to even
   * dimensions for tab capture; the override keeps logical page pixels unchanged.
   */
  private applyMetrics(entry: PaneEntry, pane: PaneContents): void {
    const { width, height } = windowSize(entry);
    pane.setContentSize(width, height);
    // Re-force the zoom: Chromium restores a per-origin zoom level at each
    // commit, which would otherwise silently replace the page's density (#646).
    pane.setZoomFactor(entry.targetDsf);
    if (!entry.documentCommitted) return;
    const revision = ++entry.metricsRevision;
    const generation = entry.mediaGeneration;
    const surfaceWidth = width + width % 2;
    const surfaceHeight = height + height % 2;
    void pane.debugger.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
    void pane.debugger
      .sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      .then(() => {
        if (this.entries.get(entry.tabId) !== entry || entry.pane !== pane || pane.isDestroyed() ||
          !entry.documentCommitted || revision !== entry.metricsRevision || generation !== entry.mediaGeneration) return;
        if (surfaceWidth !== width || surfaceHeight !== height) pane.setContentSize(surfaceWidth, surfaceHeight);
        const previous = entry.geometry;
        const geometry = { width, height, dsf: entry.targetDsf, surfaceWidth, surfaceHeight };
        entry.geometry = geometry;
        if (previous === null || previous.width !== width || previous.height !== height || previous.dsf !== geometry.dsf ||
          previous.surfaceWidth !== surfaceWidth || previous.surfaceHeight !== surfaceHeight) {
          this.onDesktopMedia?.(entry.tabId, { type: "media-geometry", tabId: entry.tabId, generation, geometry });
        }
      })
      .catch(() => {
        // Without the override the page is still right; only an agent viewport could linger.
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
