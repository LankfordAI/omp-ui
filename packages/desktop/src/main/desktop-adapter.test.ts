import { beforeEach, describe, expect, it, vi } from "vitest";
import { DCH, DESKTOP_CHANNELS } from "@omp-ui/core/desktop-channels";
import { registerDesktopAdapter, sendSurfaceTab, type DesktopAdapterDeps } from "./desktop-adapter";

type IpcListener = (event: unknown, ...args: unknown[]) => unknown;

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, IpcListener>(),
  listeners: new Map<string, IpcListener[]>(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
}));
const electron = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcListener) => ipc.handlers.set(channel, fn),
    on: (channel: string, fn: IpcListener) =>
      ipc.listeners.set(channel, [...(ipc.listeners.get(channel) ?? []), fn]),
    removeHandler: (channel: string) => {
      ipc.removeHandler(channel);
      ipc.handlers.delete(channel);
    },
    removeListener: (channel: string, fn: IpcListener) => {
      ipc.removeListener(channel, fn);
      ipc.listeners.set(channel, (ipc.listeners.get(channel) ?? []).filter((l) => l !== fn));
    },
  },
  dialog: { showSaveDialog: electron.showSaveDialog },
  shell: { openPath: electron.openPath, showItemInFolder: electron.showItemInFolder },
}));

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(ipc.handlers.get(channel)!(null, ...args));
const notify = (channel: string, ...args: unknown[]): void => {
  for (const listener of ipc.listeners.get(channel) ?? []) listener(null, ...args);
};

const sent: Array<{ channel: string; args: unknown[] }> = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

const updater = {
  state: { status: "idle", currentVersion: "1.0.0" },
  checkNow: vi.fn(async () => ({ status: "up-to-date" })),
  download: vi.fn(async () => {}),
  openReleaseNotes: vi.fn(async () => {}),
  showDownload: vi.fn(async () => {}),
  restart: vi.fn(() => "restarting"),
  setInstallOnQuit: vi.fn(),
  dismiss: vi.fn(),
};
const projectOpener = {
  availability: vi.fn(() => ({ vsCode: true, terminal: false })),
  open: vi.fn(async () => {}),
};
const deps = {
  setWindowChrome: vi.fn(),
  openExternal: vi.fn(),
  clientViewed: vi.fn(),
};

function register(): () => void {
  return registerDesktopAdapter({
    win,
    appUpdater: updater,
    projectOpener,
    ...deps,
  } as unknown as DesktopAdapterDeps);
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.handlers.clear();
  ipc.listeners.clear();
  sent.length = 0;
  electron.openPath.mockResolvedValue("");
  electron.showSaveDialog.mockResolvedValue({ canceled: true, filePath: "" });
});

describe("registerDesktopAdapter", () => {
  it("binds every request via handle, every notify via on, and no event inbound", () => {
    register();
    for (const d of Object.values(DESKTOP_CHANNELS)) {
      const bound = ipc.handlers.has(d.channel) || ipc.listeners.has(d.channel);
      switch (d.kind) {
        case "request":
          expect(ipc.handlers.has(d.channel), d.channel).toBe(true);
          expect(ipc.listeners.has(d.channel), d.channel).toBe(false);
          break;
        case "notify":
          expect(ipc.listeners.has(d.channel), d.channel).toBe(true);
          expect(ipc.handlers.has(d.channel), d.channel).toBe(false);
          break;
        case "event":
          expect(bound, d.channel).toBe(false);
          break;
      }
    }
    expect(ipc.handlers.size + ipc.listeners.size).toBe(
      Object.values(DESKTOP_CHANNELS).filter((d) => d.kind !== "event").length,
    );
  });

  it("rejects a request whose arguments fail their codec before any effect runs", async () => {
    register();
    await expect(invoke(DCH.openPath, 42)).rejects.toThrow("invalid arguments");
    await expect(invoke(DCH.openPath)).rejects.toThrow("invalid arguments");
    await expect(invoke(DCH.openPath, "/a", "extra")).rejects.toThrow("invalid arguments");
    expect(electron.openPath).not.toHaveBeenCalled();
    await expect(invoke(DCH.openProject, "/p", "emacs")).rejects.toThrow("invalid arguments");
    expect(projectOpener.open).not.toHaveBeenCalled();
  });

  it("drops a malformed notify and forwards a well-formed one", () => {
    register();
    notify(DCH.viewedTab, 7);
    expect(deps.clientViewed).not.toHaveBeenCalled();
    notify(DCH.viewedTab, "tab-1");
    notify(DCH.viewedTab, null);
    expect(deps.clientViewed.mock.calls).toEqual([["tab-1"], [null]]);
  });

  it("routes each client effect to its implementation", async () => {
    register();
    await invoke(DCH.setWindowChrome, "#000", "#fff");
    expect(deps.setWindowChrome).toHaveBeenCalledWith("#000", "#fff");
    await invoke(DCH.openPath, "/tmp/x");
    expect(electron.openPath).toHaveBeenCalledWith("/tmp/x");
    await invoke(DCH.showPathInFolder, "/tmp/y");
    expect(electron.showItemInFolder).toHaveBeenCalledWith("/tmp/y");
    await invoke(DCH.openExternal, "https://example.com");
    expect(deps.openExternal).toHaveBeenCalledWith("https://example.com");
    expect(await invoke(DCH.getProjectOpenAvailability)).toEqual({ vsCode: true, terminal: false });
    await invoke(DCH.openProject, "/p", "vscode");
    expect(projectOpener.open).toHaveBeenCalledWith("/p", "vscode");
  });

  it("surfaces shell.openPath's failure string as a rejection", async () => {
    register();
    electron.openPath.mockResolvedValueOnce("No application found");
    await expect(invoke(DCH.openPath, "/tmp/x")).rejects.toThrow("No application found");
  });

  it("chooseSavePath builds filters from the extensions, strips directories, and maps cancel to null", async () => {
    register();
    expect(await invoke(DCH.chooseSavePath, "/home/u/omp-ui-diagnostics.zip", ["zip"])).toBeNull();
    expect(electron.showSaveDialog).toHaveBeenCalledWith(win, {
      defaultPath: "omp-ui-diagnostics.zip",
      filters: [{ name: "zip", extensions: ["zip"] }],
    });

    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: "/out/a.zip" });
    expect(await invoke(DCH.chooseSavePath, "", [])).toBe("/out/a.zip");
    expect(electron.showSaveDialog).toHaveBeenLastCalledWith(win, {
      defaultPath: "untitled",
      filters: [],
    });
  });

  it("drives the client's own updater, restarting without a confirmation round-trip", async () => {
    register();
    expect(await invoke(DCH.getAppUpdateState)).toBe(updater.state);
    expect(await invoke(DCH.checkAppUpdate)).toEqual({ status: "up-to-date" });
    expect(updater.checkNow).toHaveBeenCalledWith(true);
    await invoke(DCH.downloadAppUpdate);
    expect(updater.download).toHaveBeenCalledOnce();
    await invoke(DCH.openAppUpdateReleaseNotes);
    expect(updater.openReleaseNotes).toHaveBeenCalledOnce();
    await invoke(DCH.showAppUpdateDownload);
    expect(updater.showDownload).toHaveBeenCalledOnce();
    expect(await invoke(DCH.restartForAppUpdate)).toBeUndefined();
    expect(updater.restart).toHaveBeenCalledWith(true);
    await invoke(DCH.setAppUpdateInstallOnQuit, true);
    expect(updater.setInstallOnQuit).toHaveBeenCalledWith(true);
    await invoke(DCH.dismissAppUpdate, "1.2.0", true);
    expect(updater.dismiss).toHaveBeenCalledWith("1.2.0", true);
  });

  it("unbind removes every handler and listener", () => {
    const unbind = register();
    const bound = Object.values(DESKTOP_CHANNELS).filter((d) => d.kind !== "event");
    unbind();
    expect(ipc.removeHandler).toHaveBeenCalledTimes(bound.filter((d) => d.kind === "request").length);
    expect(ipc.removeListener).toHaveBeenCalledTimes(bound.filter((d) => d.kind === "notify").length);
    expect(ipc.handlers.size).toBe(0);
    expect([...ipc.listeners.values()].flat()).toHaveLength(0);
  });
});

describe("sendSurfaceTab", () => {
  it("delivers the banner click to this window only", () => {
    sendSurfaceTab(win as never, "tab-9");
    expect(sent).toEqual([{ channel: DCH.onSurfaceTab, args: ["tab-9"] }]);
  });
});
