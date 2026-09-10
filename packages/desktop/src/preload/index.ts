import { contextBridge, ipcRenderer } from "electron";
import type { BackendTransport } from "@omp-ui/core/backend-channels";
import { makeDesktopAdapter } from "@omp-ui/core/desktop-channels";
import { makeHostBootstrap } from "@omp-ui/core/host-bootstrap-channels";

// contextIsolation stays enabled: listeners discard the Electron event and expose only typed data.
// Both surfaces below are client-local Electron IPC. The backend itself is not: the renderer dials
// the persistent host's WebSocket after `ompHostBootstrap.connection()` resolves (issue #442 §11).
const ipcTransport: BackendTransport = {
  request: (channel, args) => ipcRenderer.invoke(channel, ...args),
  notify: (channel, args) => ipcRenderer.send(channel, ...args),
  on: <Args extends unknown[]>(channel: string, cb: (...args: Args) => void) => {
    ipcRenderer.on(channel, (_event, ...args: unknown[]) => cb(...(args as unknown as Args)));
  },
};

// The desktop adapter (#454): the client effects only this machine can perform, bound in main by
// desktop-adapter.ts under the same channel strings.
contextBridge.exposeInMainWorld("ompDesktop", makeDesktopAdapter(ipcTransport));
// The bootstrap surface: where the host is, and the recovery controls when it is not.
contextBridge.exposeInMainWorld("ompHostBootstrap", makeHostBootstrap(ipcTransport));
