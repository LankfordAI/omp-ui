import { contextBridge, ipcRenderer } from "electron";
import { makeBackendClient } from "@omp-ui/core/backend-channels";

// contextIsolation stays enabled: listeners discard the Electron event and expose only typed data.
const api = makeBackendClient({
  request: (channel, args) => ipcRenderer.invoke(channel, ...args),
  notify: (channel, args) => ipcRenderer.send(channel, ...args),
  on: <Args extends unknown[]>(channel: string, cb: (...args: Args) => void) => {
    ipcRenderer.on(channel, (_event, ...args: unknown[]) => cb(...(args as unknown as Args)));
  },
});

contextBridge.exposeInMainWorld("ompBackend", api);
