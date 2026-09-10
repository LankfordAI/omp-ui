import { contextBridge, ipcRenderer } from "electron";
import { makeBackendClient } from "@omp-ui/core/backend-channels";
import { DCH, makeDesktopAdapter } from "@omp-ui/core/desktop-channels";

// contextIsolation stays enabled: listeners discard the Electron event and expose only typed data.
const api = makeBackendClient({
  request: (channel, args) => ipcRenderer.invoke(channel, ...args),
  notify: (channel, args) => ipcRenderer.send(channel, ...args),
  on: <Args extends unknown[]>(channel: string, cb: (...args: Args) => void) => {
    ipcRenderer.on(channel, (_event, ...args: unknown[]) => cb(...(args as unknown as Args)));
  },
});

// PROTOTYPE (#454): desktop channels aliased onto the IPC handlers MainBackend already binds
// (backend.ts registerIpc). The cutover replaces this map with a desktop-adapter-main table.
const IPC_ALIAS: Record<string, string> = {
  [DCH.setWindowChrome]: "window:setChrome",
  [DCH.openPath]: "file:open",
  [DCH.showPathInFolder]: "file:showInFolder",
  [DCH.getProjectOpenAvailability]: "project:openAvailability",
  [DCH.openProject]: "project:open",
  [DCH.onSurfaceTab]: "session:focus",
  [DCH.getAppUpdateState]: "app:updateGetState",
  [DCH.checkAppUpdate]: "app:updateCheck",
  [DCH.downloadAppUpdate]: "app:updateDownload",
  [DCH.openAppUpdateReleaseNotes]: "app:updateOpenNotes",
  [DCH.showAppUpdateDownload]: "app:updateShowDownload",
  [DCH.restartForAppUpdate]: "app:updateRestart",
  [DCH.setAppUpdateInstallOnQuit]: "app:updateInstallOnQuit",
  [DCH.dismissAppUpdate]: "app:updateDismiss",
  [DCH.onAppUpdateState]: "app:updateState",
};
const ipcName = (channel: string): string => IPC_ALIAS[channel] ?? channel;

const desktop = makeDesktopAdapter({
  request: (channel, args) => ipcRenderer.invoke(ipcName(channel), ...args),
  notify: (channel, args) => ipcRenderer.send(ipcName(channel), ...args),
  on: <Args extends unknown[]>(channel: string, cb: (...args: Args) => void) => {
    ipcRenderer.on(ipcName(channel), (_event, ...args: unknown[]) =>
      cb(...(args as unknown as Args)),
    );
  },
});

contextBridge.exposeInMainWorld("ompBackend", api);
contextBridge.exposeInMainWorld("ompDesktop", desktop);
