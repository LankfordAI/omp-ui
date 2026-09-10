import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { session, BrowserWindow, type Session } from "electron";
import type { VerifierPage, VerifyArgs } from "@omp-ui/host";

/**
 * The Electron BrowserWindow-backed verifier page (issue #312 follow-up;
 * ADR-0022 amended). Release P constructs the host's headless Chrome page
 * instead; this stays in the tree unused until release C deletes it.
 *
 * Trust model (§4): the top-level page is OURS (bundled `plan-verifier.html`,
 * no preload, no `ompBackend`); authored HTML enters only as a JSON-serialized
 * argument to the trusted `window.ompPlanVerifier.verify` function. The
 * dedicated session denies permissions, downloads, popups, and every request
 * the trusted page and its bundled module assets do not make themselves.
 */
export class BrowserVerifierPage implements VerifierPage {
  private constructor(private readonly win: BrowserWindow) {}

  static async create(): Promise<VerifierPage> {
    const partition = "plan-verifier";
    const ses = session.fromPartition(partition);
    guardSession(ses);
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        partition,
        // No preload at all: this page never reaches the backend bridge.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        // rAF must keep ticking in a hidden window — the layout probe waits
        // on two frames in the page's own clock.
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    // Popups cannot escape the containment.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-frame-navigate", (event) => {
      // The probe frame is created in-page by document.write; nothing may
      // navigate, and nothing may point at the top level.
      if (!event.url.startsWith("about:") && !isAllowedRequest(event.url)) {
        event.preventDefault();
      } else if (event.url.startsWith("data:") || event.url.startsWith("http")) {
        event.preventDefault();
      }
    });
    const page = new BrowserVerifierPage(win);
    await page.load();
    return page;
  }

  private async load(): Promise<void> {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl !== undefined && devUrl !== "") {
      await this.win.loadURL(`${devUrl.replace(/\/$/, "")}/plan-verifier.html`);
    } else {
      await this.win.loadFile(path.join(__dirname, "../renderer/plan-verifier.html"));
    }
    // The entry registers the trusted global during module evaluation; by
    // 'dom-ready' deferred module scripts may still be pending, so probe.
    for (let i = 0; i < 100; i += 1) {
      const present = await this.win.webContents.executeJavaScript(
        "window.ompPlanVerifier !== undefined && typeof window.ompPlanVerifier.verify === 'function'",
        true,
      );
      if (present === true) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the verifier page never registered its entry point");
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async invoke(args: VerifyArgs): Promise<unknown> {
    // The authored HTML rides as a JSON-serialized ARGUMENT to the trusted
    // function — the top-level document stays ours; authored bytes never
    // become top-level source or executable interpolation.
    const call = "window.ompPlanVerifier.verify(" + JSON.stringify(args) + ")";
    return await this.win.webContents.executeJavaScript(call, true);
  }

  dispose(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

/** Permissions, downloads, and requests all deny except the trusted assets. */
function guardSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url) });
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      cancel: !isAllowedRequest(details.url),
      requestHeaders: details.requestHeaders,
    });
  });
  ses.on("will-download", (event) => event.preventDefault());
}

/**
 * Only the exact configured page URL and its same-origin module assets are
 * allowed: the dev origin in development, the bundled renderer directory in
 * a package. data:/blob: carry no network fetch — the child CSP governs
 * those. Everything else (file or network) is denied outright, so an
 * authored frame can never fetch or file-read its way out.
 */
export function isAllowedRequest(url: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl !== undefined && devUrl !== "") {
    try {
      return url.startsWith(`${new URL(devUrl).origin}/`);
    } catch {
      return false;
    }
  }
  const rendererDirUrl = pathToFileURL(path.join(__dirname, "../renderer")).href;
  return url === rendererDirUrl || url.startsWith(`${rendererDirUrl}/`);
}
