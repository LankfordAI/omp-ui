import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { CH } from "@omp-ui/core/backend-channels";
import { createBreadcrumbRing } from "@omp-ui/core/breadcrumbs";
import { dataHome, resolveDataRoot, type BuildFlavor } from "@omp-ui/core/data-root";
import { DCH } from "@omp-ui/core/desktop-channels";
import { startFdWatchdog } from "@omp-ui/core/fd-watchdog";
import { BCH } from "@omp-ui/core/host-bootstrap-channels";
import { appendMainLog } from "@omp-ui/core/main-log";
import type { Attention, BackendState } from "@omp-ui/core/types";
import { connectInstanceClient, type InstanceClient } from "@omp-ui/server/client";
import { HOST_PROTOCOL } from "@omp-ui/server/protocol";
import { AppUpdater } from "./app-update";
import { appUpdateEnabledForBuild } from "./app-update-policy";
import { registerDesktopAdapter, sendSurfaceTab, sendToWindow } from "./desktop-adapter";
import { DesktopNotifier } from "./desktop-notifier";
import { bindHostBootstrapIpc, HostBootstrap } from "./host-bootstrap";
import { openExternalSafe } from "./open-external";
import { ProjectOpener } from "./project-open";
import { setupSpellcheck } from "./spellcheck";
import {
  fitWindowBounds,
  loadWindowState,
  saveBrowserWindowState,
  windowStatePath,
} from "./window-state";
import { installApplicationMenu } from "./application-menu";
import { shouldReloadRenderer, type ProcessDeath } from "./renderer-recovery";

// The desktop client (issue #442 §11): Electron windows, menus, spellcheck, native
// notifications and dialogs, client-local effects, renderer recovery, and its own
// update. Sessions, the registry, credentials, and both control listeners belong
// to the persistent host; this process finds or starts one (host-bootstrap.ts)
// and is then one desktop-role WebSocket client of it, exactly like the renderer.

// Packaged, standalone unpackaged, and electron-vite runs need independent
// userData dirs because requestSingleInstanceLock is scoped to userData. A
// long-lived standalone run (for example, one launched by a desktop service)
// must not make `npm run dev` start its renderer server and immediately exit.
// The packaged name is pinned rather than derived from app.name — app.name is
// the desktop id "ai.lankford.omp-ui" (desktopName in package.json), and
// existing installs must keep their window state and Chromium storage where
// they already are; the host migrates the registry out of here (§5.5). electron-vite
// exposes ELECTRON_RENDERER_URL and gets a dedicated identity. This must
// precede requestSingleInstanceLock below.
const flavor: BuildFlavor = app.isPackaged
  ? "installed"
  : process.env.ELECTRON_RENDERER_URL
    ? "dev-server"
    : "dev";
const userDataName = app.isPackaged
  ? "@omp-ui/desktop"
  : flavor === "dev-server"
    ? "@omp-ui/desktop-dev-server"
    : "@omp-ui/desktop-dev";
app.setPath("userData", join(app.getPath("appData"), userDataName));
// app.name is the desktop id; user-facing surfaces show the product name.
app.setAboutPanelOptions({ applicationName: "omp-ui" });

// Dev/test seam: opt-in CDP endpoint for programmatic renderer inspection.
if (process.env.OMP_UI_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.OMP_UI_CDP_PORT);
}

// Chromium's single-instance lock protects only this client's userData (window
// state, Chromium storage); session exclusivity is the host's authority claim.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let appQuitting = false;
  let nativeWindowReady = false;
  // Latched by AppUpdater.restart() and revoked on install failure. Electron's
  // native quitAndInstall (Squirrel.Mac / NSIS) closes all windows BEFORE any
  // before-quit fires; the darwin hide-on-close must stand down for that close
  // or the quit silently aborts and the app stays in the dock on the old
  // version (issue #244).
  let updateQuitAuthorized = false;
  // The `before-quit` flush reads window geometry from the renderer process;
  // the closure is set once whenReady has a window (see whenReady below).
  let flushWindowState: (() => void) | null = null;
  let stopFdWatchdog: (() => void) | null = null;
  let disposeNotifier: (() => void) | null = null;
  let disposeBootstrap: (() => void) | null = null;

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

    const iconPath = join(__dirname, "../../build/icon.png");
    const projectOpener = new ProjectOpener();
    const setWindowChrome = (background: string, symbol: string): void => {
      if (win.isDestroyed()) return;
      try {
        win.setTitleBarOverlay({ color: background, symbolColor: symbol, height: 36 });
      } catch {
        // No title-bar overlay on this platform (macOS hiddenInset, Linux frameless).
      }
    };

    // Main's own view of the host: the state last addressed to this connection. The
    // notifier reads titles and settings from it; the updater reads its dismissal.
    let lastState: BackendState | null = null;
    let hostClient: InstanceClient | null = null;

    const clientVersion = process.env.OMP_UI_APP_UPDATE_VERSION ?? app.getVersion();
    // The client's own artifact updater (issue #18): a client effect published to this
    // window through the desktop adapter. Its dismissal is a host setting so it follows
    // the user, read from the mirrored state and written back over the connection.
    let lastAppUpdateStatus: string | null = null;
    const appUpdater = new AppUpdater({
      win,
      // omp-ui updates are enabled for packaged Linux, Windows, and macOS
      // builds; the env override lets a dev run exercise the real flow against
      // a release.
      enabled: appUpdateEnabledForBuild({
        packaged: app.isPackaged,
        platform: process.platform,
        forceEnabled: process.env.OMP_UI_APP_UPDATE_ENABLE === "1",
      }),
      currentVersion: clientVersion,
      // Dev-only AppImage fake: APPIMAGE is never set outside a real AppImage
      // run, so without this the electron-updater path is unreachable in dev.
      env:
        process.env.OMP_UI_APP_UPDATE_FORMAT === "appimage"
          ? { APPIMAGE: "/dev/omp-ui.AppImage" }
          : undefined,
      downloadsDir: app.getPath("downloads"),
      getDismissed: () => lastState?.dismissedAppUpdateVersion ?? null,
      setDismissed: (version) => {
        // Dropped when no connection is up: the next check re-reads the mirrored state anyway.
        hostClient?.request(CH.setDismissedAppUpdateVersion, [version]).catch((error: unknown) => {
          appendMainLog(
            logDir,
            "main.log",
            `[app-update] could not persist dismissal: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
      setQuitAuthorized: (on) => {
        updateQuitAuthorized = on;
      },
      // The updater is the client's own: its state goes to this window and nowhere else.
      send: (_channel, state) => {
        // One breadcrumb per status transition, not per heartbeat (issue #413).
        if (lastAppUpdateStatus !== state.status) {
          lastAppUpdateStatus = state.status;
          breadcrumbs.record("update-stage", { detail: `app:${state.status}` });
        }
        sendToWindow(win, DCH.onAppUpdateState, state);
      },
      channel: DCH.onAppUpdateState,
    });
    stopFdWatchdog = startFdWatchdog({ logDir });

    // OS notifications for background sessions (issue #271): a desktop client of the host's
    // attention level (#442), fed from `attention:changed` on main's connection and
    // surfacing clicks into this window only (#453). Titles come from the last state this
    // connection was addressed — the same sidebar titles the renderer shows.
    const notifier = new DesktopNotifier({
      win,
      isEnabled: () => lastState?.desktopNotifications ?? false,
      localeId: () => lastState?.localeId ?? "en",
      titleOf: (tabId) => {
        for (const group of lastState?.projects ?? []) {
          const session = group.sessions.find((s) => s.tabId === tabId);
          if (session !== undefined) return session.title;
        }
        return "New session";
      },
      // The wordmark tile (build/icon.png), mirroring the BrowserWindow icon above.
      icon: () => (existsSync(iconPath) ? iconPath : null),
      surfaceTab: (tabId) => sendSurfaceTab(win, tabId),
    });
    disposeNotifier = () => notifier.dispose();
    registerDesktopAdapter({
      win,
      appUpdater,
      projectOpener,
      setWindowChrome,
      openExternal: openExternalSafe,
      clientViewed: (tabId) => notifier.clientViewed(tabId),
    });

    // Finding the host (host-bootstrap.ts): probe `host.json`, else install the embedded
    // seed and submit the supervisor start, then hand the record to the renderer through
    // the preload bootstrap surface. Every transition is pushed to the window so the
    // recovery surface can show it.
    const dataRoot = resolveDataRoot(flavor);
    const hello = { clientRole: "desktop", clientKind: "desktop", clientVersion: app.getVersion(), clientProtocol: HOST_PROTOCOL } as const;
    const controlHello = { ...hello, clientRole: "browser", clientKind: "browser" } as const;
    const bootstrap = new HostBootstrap({
      flavor,
      dataRoot,
      packaged: app.isPackaged,
      platform: process.platform,
      clientVersion: app.getVersion(),
      clientLogDir: logDir,
      legacyUserData: app.getPath("userData"),
      install: {
        root: join(dataHome(), "omp-ui-host"),
        seedDir: app.isPackaged ? join(process.resourcesPath, "host") : null,
        stableCommand: process.platform === "win32" ? null : join(homedir(), ".local", "bin", "omp-ui"),
      },
      pid: process.pid,
      // Rounded like the host's own fallback reading, inside its liveness tolerance.
      processStartMs: Math.round((Date.now() - process.uptime() * 1000) / 1000) * 1000,
      probe: (record) =>
        connectInstanceClient(record.endpoint, record.desktopCredential, { hello, timeoutMs: 2000 }),
      control: (record) =>
        connectInstanceClient(record.endpoint, record.controlCredential, { hello: controlHello, timeoutMs: 2000 }),
      run: (command) =>
        // Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
        new Promise((resolve, reject) => {
          execFile(command.cmd, command.args, { windowsHide: true }, (error, _stdout, stderr) => {
            if (error !== null && typeof error.code !== "number") {
              // Not an exit status: the supervisor command itself could not be spawned.
              reject(error);
              return;
            }
            resolve({ code: error === null ? 0 : (error.code as number), stderr: String(stderr) });
          });
        }),
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      nonce: () => randomBytes(32).toString("base64url"),
      rollbackVersion: () => lastState?.hostUpdate.rollbackVersion ?? null,
      log: (line) => appendMainLog(logDir, "main.log", line),
      onStatus: (status) => {
        breadcrumbs.record("host-bootstrap", { detail: `${status.phase}${status.message ? `: ${status.message}` : ""}` });
        sendToWindow(win, BCH.onStatus, status);
      },
    });
    // Main's own connection: the probe client that proved the host live. state:changed is
    // addressed to this connection; attention:changed is broadcast. A reconnect adopts the
    // new client the same way; only the launch update check is once per process.
    let launchUpdateCheckDone = false;
    bootstrap.onConnected((client) => {
      hostClient = client;
      client.onEvent((channel, args) => {
        if (channel === CH.onStateChanged) {
          lastState = args[0] as BackendState;
        } else if (channel === CH.onAttentionChanged) {
          notifier.onAttention(args[0] as string, args[1] as Attention | null);
        }
      });
      client.onClose(() => {
        if (hostClient === client) hostClient = null;
      });
      void client.request<BackendState>(CH.getState, []).then(
        (state) => {
          lastState = state;
          if (launchUpdateCheckDone) return;
          launchUpdateCheckDone = true;
          // omp-ui's own release check (issue #18): silent on offline/no-update, gated by
          // the launch preference; the palette's manual check goes through checkNow(true).
          if (state.appUpdateCheckOnLaunch) void appUpdater.checkNow(false);
        },
        (error: unknown) => {
          appendMainLog(
            logDir,
            "main.log",
            `[bootstrap] state:get failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    });
    const unbindBootstrap = bindHostBootstrapIpc(bootstrap);
    disposeBootstrap = () => {
      unbindBootstrap();
      bootstrap.dispose();
    };
    bootstrap.start();

    win.on("close", (e) => {
      // updateQuitAuthorized: the close was issued by native quitAndInstall,
      // which only calls app.quit() after every window closes (issue #244).
      // Closing the client touches no session; they live in the host.
      if (process.platform === "darwin" && !appQuitting && !updateQuitAuthorized) {
        e.preventDefault();
        win.hide();
      }
    });

    const rendererLoad = process.env.ELECTRON_RENDERER_URL
      ? win.loadURL(process.env.ELECTRON_RENDERER_URL)
      : win.loadFile(join(__dirname, "../renderer/index.html"));
    void rendererLoad.catch((error: unknown) => {
      revealWindow();
      throw error;
    });
  });

  app.on("before-quit", () => {
    // Persist the window geometry while the app is still alive; the sync,
    // failure-tolerating write can never block the quit. The final drag
    // inside the debounce window is read fresh here (see whenReady).
    flushWindowState?.();
    appQuitting = true;
    breadcrumbs.record("quit");
    stopFdWatchdog?.();
    disposeNotifier?.();
    // Drops main's connection only; the host and every session keep running.
    disposeBootstrap?.();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
