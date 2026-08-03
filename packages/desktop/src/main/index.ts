import { join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { clearImageScratch } from "@omp-ui/core";
import { MainBackend } from "./backend";
import { runOmpLaunchUpdateCheck } from "./omp-update";

// Dev and packaged builds resolve the same package.json name, so by default
// they also share userData — and with it the single-instance lock: an
// installed copy running made every `npm run dev` forward to it and quit
// (issue #13). Unpackaged runs get their own userData; keyed on isPackaged
// rather than ELECTRON_RENDERER_URL so bare `electron .` dev runs split too.
// Must precede requestSingleInstanceLock, which scopes the lock to userData.
if (!app.isPackaged) {
  app.setPath("userData", join(app.getPath("appData"), "@omp-ui/desktop-dev"));
}

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
  let quitDialogOpen = false;

  /**
   * Quit-guard shared by the title-bar X (window close) and every quit that
   * starts with before-quit (Ctrl+Q, app menu, app.quit()). killAll must run
   * only when the quit actually proceeds — draining `live` first would make
   * the confirm never show. Returns true when the quit may proceed.
   */
  const confirmQuitIfLive = (): boolean => {
    if (forceQuit || !backend || backend.liveCount === 0) return true;
    if (!quitDialogOpen) {
      quitDialogOpen = true;
      const win = BrowserWindow.getAllWindows()[0];
      const ask = win
        ? dialog.showMessageBox(win, {
            type: "warning",
            buttons: ["Quit", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            message: `${backend.liveCount} agent session(s) still running — quit?`,
          })
        : Promise.resolve({ response: 1 });
      void ask.then((r) => {
        quitDialogOpen = false;
        if (r.response === 0) {
          forceQuit = true;
          app.quit();
        }
      });
    }
    return false;
  };

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1600,
      height: 1000,
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
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const registryFile =
      process.env.OMP_UI_REGISTRY_PATH ?? join(app.getPath("userData"), "registry.json");
    const be = new MainBackend(win, registryFile);
    backend = be;
    be.registerIpc();
    void be.hydrateAll();

    win.on("close", (e) => {
      if (!confirmQuitIfLive()) e.preventDefault();
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, "../renderer/index.html"));
    }

    // omp install/update check: ask the user (never auto-apply) before any
    // download, then refresh the backend's resolved binary so a just-installed
    // omp is used without an app restart.
    void runOmpLaunchUpdateCheck(win, () => be.refreshOmpPath());
  });

  // Explicit kill, never SIGHUP reliance (ConPTY has no hangup semantics) —
  // but only once the quit is confirmed; before-quit fires first on menu/Ctrl+Q.
  app.on("before-quit", (e) => {
    if (!confirmQuitIfLive()) {
      e.preventDefault();
      return;
    }
    backend?.killAll();
    // Pasted-image scratch files are only ever needed by a live omp process.
    clearImageScratch();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
