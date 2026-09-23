import * as path from "node:path";
import { BrowserWindow, session } from "electron";
import type { BrowserClockStampRequest } from "@omp-ui/core";
import { guardSession } from "./plan-verifier";

/**
 * The main-process browser clock stamper (see CONTEXT.md "Browser clock").
 * Agent `Page.captureScreenshot` results are stamped in a hidden, main-owned
 * page running the renderer's `lib/clock-stamp.ts` — main has no canvas, and
 * stamping in the pane page itself would share its thread, break on agent
 * navigation, and hang while a debugger pauses it. Same hidden-page pattern
 * as the plan verifier, minus the queue: stamps are independent.
 */

/** One stamp's ceiling; a wedged page is torn down and the capture fails loudly. */
export const CLOCK_STAMP_DEADLINE_MS = 10_000;

/** The page contract; the BrowserWindow impl wraps it. Tests pass a fake. */
export interface StamperPage {
  invoke(req: BrowserClockStampRequest): Promise<unknown>;
  dispose(): void;
}

export interface ClockStamperDeps {
  createPage?: () => Promise<StamperPage>;
}

export class ClockStamper {
  private page: StamperPage | null = null;
  private pagePromise: Promise<StamperPage> | null = null;
  private disposed = false;
  private readonly createPage: () => Promise<StamperPage>;

  constructor(deps: ClockStamperDeps = {}) {
    this.createPage = deps.createPage ?? (() => BrowserStamperPage.create());
  }

  /** Base64 of the stamped image, same format as the request. Rejects with a readable reason. */
  async stamp(req: BrowserClockStampRequest): Promise<string> {
    if (this.disposed) throw new Error("the clock stamper is disposed");
    let page: StamperPage | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      page = await this.ensurePage();
      // new Promise, not Promise.withResolvers: the node tsconfig's lib predates es2024.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the clock stamper timed out")), CLOCK_STAMP_DEADLINE_MS);
      });
      const reply = await Promise.race([page.invoke(req), deadline]);
      if (typeof reply !== "string" || reply === "") throw new Error("the clock stamper returned no image");
      return reply;
    } catch (err) {
      // A failed page is never reused: the next stamp builds a fresh one. A
      // concurrent stamp may already have replaced it — leave that one alone.
      if (page !== null && this.page === page) this.teardownPage();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensurePage(): Promise<StamperPage> {
    if (this.page !== null) return this.page;
    if (this.pagePromise === null) {
      this.pagePromise = this.createPage().then(
        (page) => {
          this.pagePromise = null;
          if (this.disposed) {
            page.dispose();
            throw new Error("the clock stamper is disposed");
          }
          this.page = page;
          return page;
        },
        (err: unknown) => {
          this.pagePromise = null;
          throw err;
        },
      );
    }
    return this.pagePromise;
  }

  private teardownPage(): void {
    const page = this.page;
    this.page = null;
    try {
      page?.dispose();
    } catch {
      // best effort
    }
  }

  /** Drops the window; later stamps reject. */
  dispose(): void {
    this.disposed = true;
    this.teardownPage();
  }
}

/** Guarded once per process: the partition's session outlives every page. */
let sessionGuarded = false;

/** The BrowserWindow-backed page. Lazily created; disposable; never reused dead. */
class BrowserStamperPage implements StamperPage {
  private constructor(private readonly win: BrowserWindow) {}

  static async create(): Promise<StamperPage> {
    const partition = "clock-stamper";
    if (!sessionGuarded) {
      guardSession(session.fromPartition(partition));
      sessionGuarded = true;
    }
    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {
        partition,
        // Offscreen, like the pane itself: a plain hidden window SIGSEGVs
        // Electron under headless Ozone (verification runs, headless CI).
        offscreen: true,
        // No preload at all: this page never reaches the backend bridge.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        // A hidden window's promise and encoder work must not be throttled.
        backgroundThrottling: false,
      },
    });
    // Nothing on this page is ever looked at; the canvas work is off-DOM.
    win.webContents.stopPainting();
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    const page = new BrowserStamperPage(win);
    try {
      await page.load();
    } catch (err) {
      page.dispose();
      throw err;
    }
    return page;
  }

  private async load(): Promise<void> {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl !== undefined && devUrl !== "") {
      await this.win.loadURL(`${devUrl.replace(/\/$/, "")}/clock-stamper.html`);
    } else {
      await this.win.loadFile(path.join(__dirname, "../renderer/clock-stamper.html"));
    }
    // The entry registers the trusted global during module evaluation; by
    // 'dom-ready' deferred module scripts may still be pending, so probe.
    for (let i = 0; i < 100; i += 1) {
      const present = await this.win.webContents.executeJavaScript(
        "window.ompClockStamper !== undefined && typeof window.ompClockStamper.stamp === 'function'",
        true,
      );
      if (present === true) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the clock stamper page never registered its entry point");
  }

  async invoke(req: BrowserClockStampRequest): Promise<unknown> {
    // The request rides as a JSON-serialized ARGUMENT to the trusted function;
    // image bytes never become page source.
    return await this.win.webContents.executeJavaScript(
      "window.ompClockStamper.stamp(" + JSON.stringify(req) + ")",
      true,
    );
  }

  dispose(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}
