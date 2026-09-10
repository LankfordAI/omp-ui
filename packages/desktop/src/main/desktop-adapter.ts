import { basename } from "node:path";
import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import type { NotifyChannel, RequestChannel } from "@omp-ui/core";
import {
  DCH,
  DESKTOP_CHANNELS,
  desktopArgCodecs,
  type DesktopChannelSpec,
  type DesktopMethodName,
} from "@omp-ui/core/desktop-channels";
import type { AppUpdater } from "./app-update";
import type { ProjectOpener } from "./project-open";

export interface DesktopAdapterDeps {
  win: BrowserWindow;
  /** The client's own artifact updater; it publishes its state to the window itself. */
  appUpdater: AppUpdater;
  projectOpener: ProjectOpener;
  setWindowChrome: (background: string, symbol: string) => void;
  openExternal: (url: string) => void;
  /** This window's viewed tab, for its own banner gate (#453). */
  clientViewed: (tabId: string | null) => void;
}

type RequestHandlers = {
  readonly [M in DesktopMethodName as DesktopChannelSpec[M]["kind"] extends "request"
    ? DesktopChannelSpec[M]["channel"]
    : never]: DesktopChannelSpec[M] extends RequestChannel<infer Args, infer Result>
    ? (...args: Args) => Result | Promise<Result>
    : never;
};

type NotifyHandlers = {
  readonly [M in DesktopMethodName as DesktopChannelSpec[M]["kind"] extends "notify"
    ? DesktopChannelSpec[M]["channel"]
    : never]: DesktopChannelSpec[M] extends NotifyChannel<infer Args>
    ? (...args: Args) => void
    : never;
};

type AnyHandler = (...args: unknown[]) => unknown;

/** Every arg through its codec; a malformed tuple never reaches a handler. */
function decodeArgs(channel: string, args: unknown[]): unknown[] {
  const codecs = desktopArgCodecs.get(channel)!;
  if (args.length > codecs.length) {
    throw new Error(`invalid arguments for ${channel}: expected at most ${codecs.length}`);
  }
  try {
    return codecs.map((codec, index) => codec.decode(args[index], `argument ${index}`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "malformed argument";
    throw new Error(`invalid arguments for ${channel}: ${detail}`, { cause: error });
  }
}

/** Sends to the window unless it (or its renderer) is gone — a crashed frame throws on send (#183). */
export function sendToWindow(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) return;
  try {
    wc.send(channel, ...args);
  } catch {
    // The renderer died between the guard and the send; nothing to tell it.
  }
}

/** A banner click in this client: surface the tab here and nowhere else (#453). */
export function sendSurfaceTab(win: BrowserWindow, tabId: string): void {
  sendToWindow(win, DCH.onSurfaceTab, tabId);
}

/**
 * Binds every desktop:* channel (#454) over Electron IPC for this window: the client effects
 * only the desktop client can perform on its own machine. The host implements none of them.
 * Returns the unbind.
 */
export function registerDesktopAdapter(deps: DesktopAdapterDeps): () => void {
  const { win, appUpdater: updater, projectOpener } = deps;

  const requests: RequestHandlers = {
    [DCH.setWindowChrome]: (background, symbol) => deps.setWindowChrome(background, symbol),
    // shell.openPath resolves with an error string on failure ("" on success); rejecting lets
    // the renderer surface it instead of the click dying silently.
    [DCH.openPath]: async (absPath) => {
      const failure = await shell.openPath(absPath);
      if (failure !== "") throw new Error(failure);
    },
    [DCH.showPathInFolder]: (absPath) => {
      shell.showItemInFolder(absPath);
    },
    [DCH.openExternal]: (url) => deps.openExternal(url),
    [DCH.getProjectOpenAvailability]: () => projectOpener.availability(),
    [DCH.openProject]: (projectPath, target) => projectOpener.open(projectPath, target),
    [DCH.chooseSavePath]: async (defaultName, extensions) => {
      const result = await dialog.showSaveDialog(win, {
        defaultPath: basename(defaultName) || "untitled",
        filters:
          extensions.length > 0 ? [{ name: extensions.join(", "), extensions }] : [],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    [DCH.getAppUpdateState]: () => updater.state,
    [DCH.checkAppUpdate]: () => updater.checkNow(true),
    [DCH.downloadAppUpdate]: () => updater.download(),
    [DCH.openAppUpdateReleaseNotes]: () => updater.openReleaseNotes(),
    [DCH.showAppUpdateDownload]: () => updater.showDownload(),
    // Already confirmed: quitting the client stops no session (#455 §4).
    [DCH.restartForAppUpdate]: () => {
      updater.restart(true);
    },
    [DCH.setAppUpdateInstallOnQuit]: (on) => updater.setInstallOnQuit(on),
    [DCH.dismissAppUpdate]: (version, remember) => updater.dismiss(version, remember),
  };
  const notifies: NotifyHandlers = {
    [DCH.viewedTab]: (tabId) => deps.clientViewed(tabId),
  };

  const unbinds: Array<() => void> = [];
  for (const descriptor of Object.values(DESKTOP_CHANNELS)) {
    const { channel } = descriptor;
    switch (descriptor.kind) {
      case "request": {
        const handler = (requests as Record<string, AnyHandler>)[channel]!;
        // async: a codec rejection becomes the same rejected invoke a failing handler does.
        ipcMain.handle(channel, async (_event, ...args: unknown[]) =>
          handler(...decodeArgs(channel, args)),
        );
        unbinds.push(() => ipcMain.removeHandler(channel));
        break;
      }
      case "notify": {
        const handler = (notifies as Record<string, AnyHandler>)[channel]!;
        const listener = (_event: unknown, ...args: unknown[]): void => {
          try {
            handler(...decodeArgs(channel, args));
          } catch {
            // No reply channel — malformed input and handler failures are dropped.
          }
        };
        ipcMain.on(channel, listener);
        unbinds.push(() => ipcMain.removeListener(channel, listener));
        break;
      }
      case "event":
        break;
    }
  }

  return () => {
    for (const unbind of unbinds) unbind();
  };
}
