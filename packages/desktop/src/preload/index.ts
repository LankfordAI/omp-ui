import { contextBridge, ipcRenderer } from "electron";
import { makeBackendClient } from "@omp-ui/core/backend-channels";
import { makeDesktopAdapter } from "@omp-ui/core/desktop-channels";

// contextIsolation stays enabled: listeners discard the Electron event and expose only typed data.
const api = makeBackendClient({
  request: (channel, args) => ipcRenderer.invoke(channel, ...args),
  notify: (channel, args) => ipcRenderer.send(channel, ...args),
  on: <Args extends unknown[]>(channel: string, cb: (...args: Args) => void) => {
    ipcRenderer.on(channel, (_event, ...args: unknown[]) => cb(...(args as unknown as Args)));
  },
});

// The desktop adapter (#454): the client effects only this machine can perform, bound in main by
// desktop-adapter.ts under the same channel strings.
const desktop = makeDesktopAdapter({
  request: (channel, args) => ipcRenderer.invoke(channel, ...args),
  notify: (channel, args) => ipcRenderer.send(channel, ...args),
  on: <Args extends unknown[]>(channel: string, cb: (...args: Args) => void) => {
    ipcRenderer.on(channel, (_event, ...args: unknown[]) => cb(...(args as unknown as Args)));
  },
});

contextBridge.exposeInMainWorld("ompBackend", api);
contextBridge.exposeInMainWorld("ompDesktop", desktop);
