import { join } from "node:path";
import { app, BrowserWindow, dialog, screen } from "electron";
import { clearImageScratch, formatModelRole } from "@omp-ui/core";
import { MainBackend } from "./backend";
import { appUpdateEnabledForBuild } from "./app-update-policy";
import { openExternalSafe } from "./open-external";
import { setupSpellcheck } from "./spellcheck";
import {
  fitWindowBounds,
  loadWindowState,
  saveBrowserWindowState,
  windowStatePath,
} from "./window-state";
import { installApplicationMenu } from "./application-menu";
import { startFdWatchdog } from "./fd-watchdog";
import { appendMainLog } from "./main-log";
import { createBreadcrumbRing } from "./breadcrumbs";
import { gateSelector, parseSpawnGate } from "./spawn-gate";
import { shouldReloadRenderer, type ProcessDeath } from "./renderer-recovery";

// Packaged, standalone unpackaged, and electron-vite runs need independent
// userData dirs because requestSingleInstanceLock is scoped to userData. A
// long-lived standalone run (for example, one launched by a desktop service)
// must not make `npm run dev` start its renderer server and immediately exit.
// The packaged name is pinned rather than derived from app.name — app.name is
// the desktop id "ai.lankford.omp-ui" (desktopName in package.json), and
// existing installs must keep their registry, window state, and Chromium
// storage where they already are. electron-vite exposes ELECTRON_RENDERER_URL
// and gets a dedicated identity. This must precede requestSingleInstanceLock
// below.
const userDataName = app.isPackaged
  ? "@omp-ui/desktop"
  : process.env.ELECTRON_RENDERER_URL
    ? "@omp-ui/desktop-dev-server"
    : "@omp-ui/desktop-dev";
app.setPath("userData", join(app.getPath("appData"), userDataName));
// app.name is the desktop id; user-facing surfaces show the product name.
app.setAboutPanelOptions({ applicationName: "omp-ui" });

// Dev/test seam: opt-in CDP endpoint for programmatic renderer inspection.
if (process.env.OMP_UI_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.OMP_UI_CDP_PORT);
}

// Single-instance is mandatory: the no-double-resume rule can't see across
// two omp-ui instances (omp has no cross-process session lock).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let backend: MainBackend | null = null;
  let forceQuit = false;
  let appQuitting = false;
  let quitDialogOpen = false;
  let nativeWindowReady = false;
  // Latched by AppUpdater.restart() and revoked on install failure. Electron's
  // native quitAndInstall (Squirrel.Mac / NSIS) closes all windows BEFORE any
  // before-quit fires; the darwin hide-on-close and both live-session quit
  // guards must stand down for that close or the quit silently aborts and the
  // app stays in the dock on the old version (issue #244).
  let updateQuitAuthorized = false;
  // The `before-quit` flush reads window geometry from the renderer process;
  // the closure is set once whenReady has a window (see whenReady below).
  let flushWindowState: (() => void) | null = null;
  let stopFdWatchdog: (() => void) | null = null;

  // The userData path is pinned above, so the log dir and the breadcrumb sink
  // can exist before whenReady — process-error hooks registered here still
  // land on disk (issue #413). whenReady's telemetry below shares this logDir.
  const logDir = join(app.getPath("userData"), "logs");
  const breadcrumbs = createBreadcrumbRing(logDir);
  breadcrumbs.record("launch", { detail: `v${app.getVersion()} packaged=${app.isPackaged}` });

  // No plain uncaughtException handler: that would keep the process limping
  // in undefined state. uncaughtExceptionMonitor records without changing
  // Node's default behavior. A plain unhandledRejection listener REPLACES
  // Node's printed warning (exit 1 → silent 0), so this handler re-emits it
  // to main.log itself.
  process.on("uncaughtExceptionMonitor", (error) => {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    breadcrumbs.record("main-exception", { detail: text });
    appendMainLog(logDir, "main.log", `[error] uncaught exception: ${text}`);
  });
  process.on("unhandledRejection", (reason) => {
    const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    breadcrumbs.record("main-rejection", { detail: text });
    appendMainLog(logDir, "main.log", `[error] unhandled rejection: ${text}`);
  });

  /** Awaitable quit guard used by window and application quit paths. */
  const confirmLiveQuit = async (): Promise<boolean> => {
    if (forceQuit || updateQuitAuthorized || !backend || backend.sessions.liveCount === 0)
      return true;
    if (quitDialogOpen) return false;
    quitDialogOpen = true;
    const win = BrowserWindow.getAllWindows()[0];
    try {
      if (!win) return false;
      const r = await dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["Quit", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: `${backend.sessions.liveCount} agent session(s) still running — quit?`,
      });
      if (r.response !== 0) return false;
      forceQuit = true;
      return true;
    } finally {
      quitDialogOpen = false;
    }
  };

  /**
   * Quit guard used by non-Darwin window close and every quit that starts with
   * before-quit (Ctrl+Q, app menu, app.quit()). killAll must run only when the
   * quit actually proceeds — draining `live` first would make the confirm
   * never show. Returns true when the quit may proceed.
   */
  const confirmQuitIfLive = (): boolean => {
    if (forceQuit || updateQuitAuthorized || !backend || backend.sessions.liveCount === 0)
      return true;
    void confirmLiveQuit().then((ok) => {
      if (ok) app.quit();
    });
    return false;
  };

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!nativeWindowReady) return;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on("activate", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!nativeWindowReady) return;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  void app.whenReady().then(() => {
    installApplicationMenu();

    // Tier-3 update restore (issue #99): the window's geometry outlives an
    // update relaunch. loadWindowState guards every corruption path; a missing
    // or unusable file keeps the 1600x1000 defaults below.
    const winStateFile = windowStatePath(app.getPath("userData"));
    let savedWindowState = loadWindowState(winStateFile);
    if (savedWindowState) {
      // getDisplayMatching and workArea are only valid after whenReady.
      const fitted = fitWindowBounds(
        savedWindowState.bounds,
        screen.getDisplayMatching(savedWindowState.bounds).workArea,
      );
      if (fitted === null) savedWindowState = null;
      else savedWindowState = { ...savedWindowState, bounds: fitted };
    }
    const win = new BrowserWindow({
      ...(savedWindowState === null
        ? { width: 1600, height: 1000 }
        : savedWindowState.bounds),
      // Keep Chromium's startup geometry hidden from Mutter until the renderer
      // is ready; mapping a transient zero-area frame can crash GNOME Shell
      // (https://gitlab.gnome.org/GNOME/mutter/-/work_items/4343).
      show: false,
      title: "omp-ui",
      backgroundColor: "#0a0b0d",
      // The wordmark tile (build/icon.png). Only shipped in dev checkouts —
      // packaged builds get their icon from the .desktop/AppImage metadata,
      // and Electron treats a missing icon path as a no-op.
      icon: join(__dirname, "../../build/icon.png"),
      // The GTK frame + menu bar clash with the renderer's chrome. Hidden
      // title bar + overlay keeps native window controls (drawn in app
      // colors); the renderer supplies the drag region. Alt reveals the menu.
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#0a0b0d", symbolColor: "#a8b2bf", height: 36 },
      ...(process.platform === "darwin"
        ? { trafficLightPosition: { x: 12, y: 10 } }
        : {}),
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    breadcrumbs.record("window-created", { detail: `state=${savedWindowState ? "restored" : "fresh"}` });

    let revealed = false;
    const revealWindow = (): void => {
      if (revealed || win.isDestroyed()) return;
      revealed = true;
      nativeWindowReady = true;
      if (savedWindowState?.maximized) win.maximize();
      win.show();
    };
    win.once("ready-to-show", revealWindow);

    setupSpellcheck(win);

    // Debounced capture: a final drag inside the debounce window is read fresh
    // at flush, never lost. Persist neither minimized nor fullscreen state.
    let winStateTimer: ReturnType<typeof setTimeout> | undefined;
    const queueWindowStateSave = (): void => {
      clearTimeout(winStateTimer);
      winStateTimer = setTimeout(() => {
        winStateTimer = undefined;
        flushWindowState?.();
      }, 250);
    };
    flushWindowState = (): void => {
      if (winStateTimer !== undefined) {
        clearTimeout(winStateTimer);
        winStateTimer = undefined;
      }
      saveBrowserWindowState(winStateFile, win);
    };
    win.on("move", queueWindowStateSave);
    win.on("resize", queueWindowStateSave);
    win.on("maximize", queueWindowStateSave);
    win.on("unmaximize", queueWindowStateSave);

    // Renderer anchors keep calling window.open (Markdown.tsx / tool slabs);
    // every one of those lands here, denied in-window and routed to the system
    // browser via the scheme allow-list (issue #101).
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: "deny" };
    });

    // The plan-review iframe (PlanReview.tsx) is the only iframe in the app and
    // renders agent-authored HTML under `sandbox=""` — no scripts, opaque
    // origin. An empty sandbox still blocks only *top* navigation, so a link
    // click inside it navigates the frame itself: the reviewed plan would be
    // replaced by a remote page and a request would leave the machine off a
    // model-chosen URL. The frame only ever loads its own srcdoc, so deny every
    // other subframe navigation and route web URLs to the system browser,
    // exactly like window.open above.
    win.webContents.on("will-frame-navigate", (details) => {
      if (details.isMainFrame || details.url.startsWith("about:")) return;
      details.preventDefault();
      openExternalSafe(details.url);
    });

    // Process-death telemetry + bounded renderer recovery (issues #183, #184):
    // a dead renderer must never leave a blank window for the user to kill.
    const rendererDeaths: ProcessDeath[] = [];
    win.webContents.on("render-process-gone", (_event, details) => {
      rendererDeaths.push({ at: Date.now(), reason: details.reason });
      appendMainLog(
        logDir,
        "main.log",
        `[renderer] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`,
      );
      breadcrumbs.record("renderer-gone", {
        detail: `reason=${details.reason} exitCode=${details.exitCode}`,
      });
      if (win.isDestroyed()) return;
      if (shouldReloadRenderer(details.reason, rendererDeaths, Date.now())) {
        appendMainLog(logDir, "main.log", "[renderer] reloading webContents after death");
        breadcrumbs.record("renderer-reload");
        win.webContents.reload();
      } else {
        appendMainLog(
          logDir,
          "main.log",
          "[renderer] crash loop — leaving window dead; restart the app",
        );
        breadcrumbs.record("renderer-crash-loop");
      }
    });
    win.webContents.on("unresponsive", () => {
      appendMainLog(logDir, "main.log", "[renderer] unresponsive");
      breadcrumbs.record("renderer-unresponsive");
    });
    app.on("child-process-gone", (_event, details) => {
      // GPU/utility deaths blank or freeze the UI without killing the renderer.
      appendMainLog(
        logDir,
        "main.log",
        `[process] child-process-gone type=${details.type} reason=${details.reason}`,
      );
      breadcrumbs.record("child-process-gone", {
        detail: `type=${details.type} reason=${details.reason}`,
      });
    });

    const registryFile =
      process.env.OMP_UI_REGISTRY_PATH ?? join(app.getPath("userData"), "registry.json");
    // Dev/test seam (docs/development.md): when set, every session this instance
    // spawns — fresh or resumed, terminal or native — pins its main model (and, for
    // OMP_UI_TEST_ADVISOR, its advisor model) to a cheap selector. Logged once so a
    // verification run cannot silently believe it tested the user's real model mix.
    const spawnGate = parseSpawnGate(process.env);
    if (spawnGate.model !== null || spawnGate.advisorModel !== null) {
      console.info(
        `[spawn-gate] every session pins model=${gateSelector(spawnGate) ?? "unchanged"}` +
          ` advisor=${
            spawnGate.advisorModel === null ? "unchanged" : formatModelRole(spawnGate.advisorModel)
          }`,
      );
    }
    const be = new MainBackend(win, registryFile, {
      setAppUpdateQuitAuthorized: (on) => {
        updateQuitAuthorized = on;
      },
      // omp-ui updates are enabled for packaged Linux, Windows, and macOS
      // builds; the env override lets a dev run exercise the real flow against
      // a release.
      appUpdateEnabled: appUpdateEnabledForBuild({
        packaged: app.isPackaged,
        platform: process.platform,
        forceEnabled: process.env.OMP_UI_APP_UPDATE_ENABLE === "1",
      }),
      appVersion: process.env.OMP_UI_APP_UPDATE_VERSION ?? app.getVersion(),
      // Dev-only AppImage fake: APPIMAGE is never set outside a real AppImage
      // run, so without this the electron-updater path is unreachable in dev.
      appUpdateEnv:
        process.env.OMP_UI_APP_UPDATE_FORMAT === "appimage"
          ? { APPIMAGE: "/dev/omp-ui.AppImage" }
          : undefined,
      // __dirname is out/main in dev and packaged alike, so out/web resolves in both; inside
      // app.asar Electron's patched fs reads it normally.
      webRoot: join(__dirname, "../web"),
      spawnGate,
      logDir,
      breadcrumbs,
    });
    backend = be;
    stopFdWatchdog = startFdWatchdog({ logDir });
    be.registerIpc();
    void be.hydrateAll();
    void be.startRemote();
    be.startRemoteInstances();
    // A .desktop/AppImage/dock launch inherits the session-manager environment,
    // never ~/.zshrc — so keys the user exported from their shell are invisible
    // and omp's model catalog collapses to the providers needing no auth. Void-
    // fired: sessions spawn on user action, long after this settles, and the
    // stored keys are already applied synchronously in the constructor.
    void be.captureShellKeys();
    // The fresh-spawn gate consults the subscription account cache, so prime
    // it at boot the same way the shell keys are (issue #368).
    void be.refreshProviderOAuth();

    win.on("close", (e) => {
      // updateQuitAuthorized: the close was issued by native quitAndInstall,
      // which only calls app.quit() after every window closes (issue #244).
      if (process.platform === "darwin" && !appQuitting && !updateQuitAuthorized) {
        e.preventDefault();
        win.hide();
      } else if (process.platform !== "darwin" && !confirmQuitIfLive()) {
        e.preventDefault();
      }
    });

    const rendererLoad = process.env.ELECTRON_RENDERER_URL
      ? win.loadURL(process.env.ELECTRON_RENDERER_URL)
      : win.loadFile(join(__dirname, "../renderer/index.html"));
    void rendererLoad.catch((error: unknown) => {
      revealWindow();
      throw error;
    });

    // omp install/update check (issue #19): silent on offline/no-update,
    // void-fired so first paint never waits on the registry.
    be.checkOmpUpdateBackground();

    // omp-ui's own release check (issue #18): silent on offline/no-update,
    // void-fired so first paint never waits on GitHub.
    be.checkAppUpdateBackground();
  });

  // Explicit kill, never SIGHUP reliance (ConPTY has no hangup semantics) —
  // but only once the quit is confirmed; before-quit fires first on menu/Ctrl+Q.
  app.on("before-quit", (e) => {
    if (!confirmQuitIfLive()) {
      e.preventDefault();
      return;
    }
    // Persist the window geometry while the app is still alive; the sync,
    // failure-tolerating write can never block the quit. The final drag
    // inside the debounce window is read fresh here (see whenReady).
    flushWindowState?.();
    appQuitting = true;
    breadcrumbs.record("quit", { detail: `forced=${forceQuit}` });
    stopFdWatchdog?.();
    backend?.killAll();
    // Pasted-image scratch files are only ever needed by a live omp process.
    clearImageScratch();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
