import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, screen, shell } from "electron";
import {
  appendMainLog,
  CH,
  clearImageScratch,
  createBreadcrumbRing,
  detectPackageFormat,
  formatModelRole,
  startFdWatchdog,
  type Attention,
  type BackendState,
} from "@omp-ui/core";
import { DCH } from "@omp-ui/core/desktop-channels";
import {
  claimLegacyElectronAuthority,
  gateSelector,
  HostApplication,
  IPC_CONNECTION_ID,
  parseSpawnGate,
  type ClientEffects,
} from "@omp-ui/host";
import { HOST_PROTOCOL, type ConnectionContext } from "@omp-ui/server";
import { AppUpdater } from "./app-update";
import { appUpdateEnabledForBuild } from "./app-update-policy";
import { refuseLegacyAuthorityIfClaimed } from "./authority-tripwire";
import { registerDesktopAdapter, sendSurfaceTab, sendToWindow } from "./desktop-adapter";
import { DesktopNotifier } from "./desktop-notifier";
import { bindBackendIpc, bindWindowSink } from "./ipc-bridge";
import { electronKeyCipher } from "./key-cipher";
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
  let host: HostApplication | null = null;
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
  let disposeNotifier: (() => void) | null = null;

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
    if (forceQuit || updateQuitAuthorized || host === null || host.liveCount === 0) return true;
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
        message: `${host.liveCount} agent session(s) still running — quit?`,
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
   * before-quit (Ctrl+Q, app menu, app.quit()). shutdown must run only when the
   * quit actually proceeds — draining `live` first would make the confirm
   * never show. Returns true when the quit may proceed.
   */
  const confirmQuitIfLive = (): boolean => {
    if (forceQuit || updateQuitAuthorized || host === null || host.liveCount === 0) return true;
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

    // Release P tripwire (issue #442): a canonical host root with permanent claim
    // evidence belongs to a persistent host; this legacy Electron authority must
    // refuse before Registry.load could touch anything.
    refuseLegacyAuthorityIfClaimed({ logDir, breadcrumbs });
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
    // Every store beside the registry; the data root is the registry's directory so a
    // relocated OMP_UI_REGISTRY_PATH carries the whole layout with it.
    const dataRoot = dirname(registryFile);
    const hostVersion = process.env.OMP_UI_APP_UPDATE_VERSION ?? app.getVersion();
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
    // The client effects the host's BACKEND_CHANNELS still carry in P (#454 moves them to desktop:*).
    const clientEffects: ClientEffects = {
      // shell.openPath resolves with an error string on failure ("" on success); rejecting lets
      // the renderer surface it instead of the click dying silently.
      openPath: async (absPath) => {
        const failure = await shell.openPath(absPath);
        if (failure !== "") throw new Error(failure);
      },
      showPathInFolder: (absPath) => shell.showItemInFolder(absPath),
      openProject: (projectPath, target) => projectOpener.open(projectPath, target),
      getProjectOpenAvailability: () => projectOpener.availability(),
      setWindowChrome,
      chooseDiagnosticsPath: async (basename) => {
        const result = await dialog.showSaveDialog(win, {
          defaultPath: basename || "omp-ui-diagnostics.zip",
          filters: [{ name: "Zip archive", extensions: ["zip"] }],
        });
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      // The updater is constructed after the host it reads dismissals from; the host only ever
      // reaches it from a channel handler, long after both exist.
      get appUpdate() {
        return appUpdater;
      },
    };
    const application = new HostApplication({
      paths: {
        dataRoot,
        registryFile,
        providerKeysFile: join(dataRoot, "provider-keys.json"),
        remoteInstancesFile: join(dataRoot, "remote-instances.json"),
        worktreesRoot: join(dataRoot, "worktrees"),
        oauthScratchDir: join(dataRoot, "oauth-login"),
        logDir,
        // __dirname is out/main in dev and packaged alike, so out/web resolves in both; inside
        // app.asar Electron's patched fs reads it normally.
        webRoot: join(__dirname, "../web"),
      },
      hostVersion,
      cipher: electronKeyCipher(),
      // Release P: Chromium's single-instance lock plus the tripwire above are the witness.
      authority: claimLegacyElectronAuthority(dataRoot),
      // The headless plan verifier (issue #442 §8): the pinned Chrome for Testing
      // rides in resources/plan-verifier and its page in resources/verifier-page
      // when packaged; a dev run points OMP_UI_VERIFIER_BROWSER at a fetched
      // payload and reads the page from packages/host/dist/verifier.
      verifier: {
        resourcesDir: process.resourcesPath,
        packaged: app.isPackaged,
        runtimeDir: join(app.getPath("userData"), "runtime"),
        pageDir: app.isPackaged
          ? join(process.resourcesPath, "verifier-page")
          : join(__dirname, "../../../host/dist/verifier"),
      },
      breadcrumbs,
      spawnGate,
      clientFacts: () => ({
        clientVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? null,
        chromeVersion: process.versions.chrome ?? null,
        windowStateFile: winStateFile,
        packaged: app.isPackaged,
        packageFormat: detectPackageFormat(),
      }),
      clientEffects,
    });
    host = application;
    // The client's own artifact updater (issue #18): reads its dismissal from the host's registry
    // at construction, so it follows the host.
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
      currentVersion: hostVersion,
      // Dev-only AppImage fake: APPIMAGE is never set outside a real AppImage
      // run, so without this the electron-updater path is unreachable in dev.
      env:
        process.env.OMP_UI_APP_UPDATE_FORMAT === "appimage"
          ? { APPIMAGE: "/dev/omp-ui.AppImage" }
          : undefined,
      downloadsDir: app.getPath("downloads"),
      getDismissed: () => application.getSetting("dismissedAppUpdateVersion"),
      setDismissed: (v) => application.setSetting("dismissedAppUpdateVersion", v),
      hasLiveSessions: () => application.liveCount > 0,
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
    // The window's own connection (issue #442): the one desktop-role, loopback client. Its version is
    // this build's; a control grant is WP4's to decide.
    const ipcCtx: ConnectionContext = {
      id: IPC_CONNECTION_ID,
      role: "desktop",
      local: true,
      control: false,
      clientKind: "desktop",
      clientVersion: app.getVersion(),
      protocolVersion: HOST_PROTOCOL,
    };
    bindBackendIpc(application, ipcCtx);
    bindWindowSink(application, win);
    // OS notifications for background sessions (issue #271): a desktop client of the host's
    // attention level (#442), subscribed to `attention:changed` like any other sink and
    // surfacing clicks into this window only (#453). Titles come from the last state this
    // connection was addressed — the same sidebar titles the renderer shows.
    let lastState: BackendState | null = null;
    const notifier = new DesktopNotifier({
      win,
      isEnabled: () => application.getSetting("desktopNotifications"),
      localeId: () => application.getSetting("localeId"),
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
    application.addSink((scope, channel, args) => {
      if (channel === CH.onStateChanged && scope.kind === "connection" && scope.id === IPC_CONNECTION_ID) {
        lastState = args[0] as BackendState;
      } else if (channel === CH.onAttentionChanged && scope.kind === "broadcast") {
        notifier.onAttention(args[0] as string, args[1] as Attention | null);
      }
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
    void application.hydrateAll();
    void application.startRemote();
    application.startRemoteInstances();
    // A .desktop/AppImage/dock launch inherits the session-manager environment,
    // never ~/.zshrc — so keys the user exported from their shell are invisible
    // and omp's model catalog collapses to the providers needing no auth. Void-
    // fired: sessions spawn on user action, long after this settles, and the
    // stored keys are already applied synchronously in the constructor.
    void application.captureShellKeys();
    // The fresh-spawn gate consults the subscription account cache, so prime
    // it at boot the same way the shell keys are (issue #368).
    void application.refreshProviderOAuth();

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
    application.checkOmpUpdateBackground();

    // omp-ui's own release check (issue #18): silent on offline/no-update,
    // void-fired so first paint never waits on GitHub. Gated by the launch
    // preference; the palette's manual check goes through checkNow(true).
    if (application.getSetting("appUpdateCheckOnLaunch")) void appUpdater.checkNow(false);
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
    disposeNotifier?.();
    void host?.shutdown();
    // Pasted-image scratch files are only ever needed by a live omp process.
    clearImageScratch();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
