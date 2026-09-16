import { BrowserWindow, session } from "electron";
import {
  isAllowedBrowserPaneSubframeUrl,
  isAllowedBrowserPaneTopLevelUrl,
  type BrowserPaneInputEvent,
  type BrowserPaneModifier,
} from "@omp-ui/core";
import { guardBrowserPaneSession } from "./browser-pane-guard";

/**
 * The browser pane's page seam (#519, ADR-0029). `PaneContents` is the only
 * surface `BrowserPaneHost` touches; `makeElectronPaneFactory` is the only
 * pane code that imports Electron (the `PlanVerifierDeps.createPage` idiom),
 * so the host and its tests run without a runtime.
 */

export interface PaneDebugger {
  attach(protocolVersion: "1.3"): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(
    event: "message",
    cb: (event: unknown, method: string, params: unknown, sessionId?: string) => void,
  ): void;
  on(event: "detach", cb: (event: unknown, reason: string) => void): void;
}

export type PaneEvent =
  | "did-navigate"
  | "did-navigate-in-page"
  | "did-start-loading"
  | "did-stop-loading"
  | "page-title-updated"
  | "destroyed"
  | "context-menu";

export interface PaintImage {
  toJPEG(quality: number): Buffer;
  getSize(): { width: number; height: number };
}

export interface PaneContents {
  onPaint(
    cb: (dirtyRect: { x: number; y: number; width: number; height: number }, image: PaintImage) => void,
  ): () => void;
  setFrameRate(fps: number): void;
  startPainting(): void;
  stopPainting(): void;
  invalidate(): void;
  setContentSize(width: number, height: number): void;
  getContentSize(): { width: number; height: number };
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  sendInputEvent(
    event: Exclude<BrowserPaneInputEvent, { type: "insertText" | "edit" | "imeSetComposition" }>,
  ): void;
  insertText(text: string): Promise<void>;
  imeSetComposition(text: string, selectionStart: number, selectionEnd: number): Promise<void>;
  focus(): void;
  selectAll(): void;
  copy(): void;
  paste(): void;
  cut(): void;
  undo(): void;
  redo(): void;
  readonly debugger: PaneDebugger;
  readonly userAgent: string;
  on(event: PaneEvent, cb: (...args: unknown[]) => void): () => void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface CreatePaneOptions {
  partition: string;
  deviceScaleFactor: number;
  width: number;
  height: number;
  /** #529 popups: deny and hand the URL back for in-pane navigation through the guard. */
  onPopup: (url: string) => void;
}

export type CreatePane = (opts: CreatePaneOptions) => Promise<PaneContents>;

type ElectronModifier = NonNullable<Electron.InputEvent["modifiers"]>[number];

/**
 * The wire spelling is camelCase; Electron's typed list is lowercase. The
 * three button names are the buttons held during a drag (the renderer's
 * `MouseEvent.buttons` bits), which Electron spells `*buttondown`.
 */
const ELECTRON_MODIFIERS: Record<BrowserPaneModifier, ElectronModifier> = {
  shift: "shift",
  control: "control",
  alt: "alt",
  meta: "meta",
  capsLock: "capslock",
  isKeypad: "iskeypad",
  left: "leftbuttondown",
  middle: "middlebuttondown",
  right: "rightbuttondown",
};

/**
 * The BrowserWindow-backed pane. The guard is installed on the partition
 * before the first window and once per Session; `deniedPorts` is read on
 * every request so a bridge port minted later is still unreachable (#531).
 */
export function makeElectronPaneFactory(deniedPorts: () => ReadonlySet<number>): CreatePane {
  return async (opts) => {
    guardBrowserPaneSession(session.fromPartition(opts.partition), deniedPorts);
    // Undocumented in electron.d.ts but honoured by the offscreen renderer
    // (#526 prototype evidence): paints arrive at this dsf.
    const offscreen: Electron.Offscreen & { deviceScaleFactor: number } = {
      deviceScaleFactor: opts.deviceScaleFactor,
    };
    const win = new BrowserWindow({
      show: false,
      width: opts.width,
      height: opts.height,
      useContentSize: true,
      webPreferences: {
        offscreen,
        partition: opts.partition,
        // No preload at all: this page never reaches the backend bridge.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // Hidden windows must keep painting; the pane is never shown.
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    const wc = win.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      opts.onPopup(url);
      return { action: "deny" };
    });
    // Layer 2 of #531: the allow-lists at navigation time, top level and frames.
    wc.on("will-navigate", (event, url) => {
      if (!isAllowedBrowserPaneTopLevelUrl(url)) event.preventDefault();
    });
    wc.on("will-frame-navigate", (details) => {
      const allowed = details.isMainFrame
        ? isAllowedBrowserPaneTopLevelUrl(details.url)
        : isAllowedBrowserPaneSubframeUrl(details.url);
      if (!allowed) details.preventDefault();
    });
    // Layer 4 (#531 S11): a navigation the agent starts over CDP skips
    // will-navigate; the request layer cancels it, but Chromium would still
    // commit an error page for the blocked URL. Stopping keeps the current
    // document on screen — deferred, because Stop() from inside
    // DidStartNavigation trips a Chromium CHECK (SIGTRAP).
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument && !isAllowedBrowserPaneTopLevelUrl(details.url)) {
        setImmediate(() => {
          if (!wc.isDestroyed()) wc.stop();
        });
      }
    });
    const userAgent = wc.getUserAgent();
    return {
      onPaint(cb) {
        const handler = (
          _event: Electron.Event,
          dirtyRect: Electron.Rectangle,
          image: Electron.NativeImage,
        ): void => cb(dirtyRect, image);
        wc.on("paint", handler);
        return () => {
          if (!wc.isDestroyed()) wc.off("paint", handler);
        };
      },
      setFrameRate: (fps) => wc.setFrameRate(fps),
      startPainting: () => wc.startPainting(),
      stopPainting: () => wc.stopPainting(),
      invalidate: () => wc.invalidate(),
      setContentSize: (width, height) => win.setContentSize(width, height),
      getContentSize() {
        const [width, height] = win.getContentSize();
        return { width: width ?? opts.width, height: height ?? opts.height };
      },
      loadURL: (url) => wc.loadURL(url),
      goBack: () => wc.navigationHistory.goBack(),
      goForward: () => wc.navigationHistory.goForward(),
      reload: () => wc.reload(),
      stop: () => wc.stop(),
      canGoBack: () => wc.navigationHistory.canGoBack(),
      canGoForward: () => wc.navigationHistory.canGoForward(),
      getURL: () => wc.getURL(),
      getTitle: () => wc.getTitle(),
      isLoading: () => wc.isLoading(),
      sendInputEvent(event) {
        const modifiers = event.modifiers?.map((m) => ELECTRON_MODIFIERS[m]);
        switch (event.type) {
          case "mouseWheel":
            wc.sendInputEvent({
              type: "mouseWheel",
              x: event.x,
              y: event.y,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              hasPreciseScrollingDeltas: event.hasPreciseScrollingDeltas,
              canScroll: true,
              modifiers,
            });
            return;
          case "keyDown":
          case "keyUp":
          case "char":
            wc.sendInputEvent({ type: event.type, keyCode: event.keyCode, modifiers });
            return;
          default:
            wc.sendInputEvent({
              type: event.type,
              x: event.x,
              y: event.y,
              button: event.button,
              clickCount: event.clickCount,
              modifiers,
            });
        }
      },
      insertText: (text) => wc.insertText(text),
      // Preedit has no Electron API; the page's root debugger session carries it as CDP (#541).
      imeSetComposition: (text, selectionStart, selectionEnd) =>
        wc.debugger
          .sendCommand("Input.imeSetComposition", { text, selectionStart, selectionEnd })
          .then(() => undefined),
      focus: () => wc.focus(),
      selectAll: () => wc.selectAll(),
      copy: () => wc.copy(),
      paste: () => wc.paste(),
      cut: () => wc.cut(),
      undo: () => wc.undo(),
      redo: () => wc.redo(),
      debugger: wc.debugger,
      userAgent,
      on(event, cb) {
        // Electron types `on` per event name; the PaneEvent union goes through
        // the EventEmitter base the WebContents class extends.
        const emitter: NodeJS.EventEmitter = wc;
        emitter.on(event, cb);
        return () => {
          if (!wc.isDestroyed()) emitter.off(event, cb);
        };
      },
      destroy() {
        if (!wc.isDestroyed()) wc.close();
        if (!win.isDestroyed()) win.destroy();
      },

      isDestroyed: () => win.isDestroyed(),
    };
  };
}
/** Clears everything persisted by the browser pane profile (#542). */
export async function clearBrowserPanePartition(partition: string): Promise<void> {
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
}
