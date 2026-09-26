import { contextBridge, ipcRenderer } from "electron";
import { CH, makeBackendClient } from "@omp-ui/core/backend-channels";
import {
  DESKTOP_PANE_PORT,
  DESKTOP_PANE_PORT_REQUEST,
  DESKTOP_PANE_WINDOW_PORT,
  DESKTOP_PANE_WINDOW_REQUEST,
  type DesktopBackendBridge,
} from "../browser-pane-desktop-protocol";

// contextIsolation stays enabled: listeners discard the Electron event and expose only typed data.
const api = makeBackendClient({
  request: (channel, args) => ipcRenderer.invoke(channel, ...args),
  notify: (channel, args) => ipcRenderer.send(channel, ...args),
  on: <Args extends unknown[]>(channel: string, cb: (...args: Args) => void) => {
    if (channel === CH.onBrowserPaneFrame) return;
    ipcRenderer.on(channel, (_event, ...args: unknown[]) => cb(...(args as unknown as Args)));
  },
});

const { onBrowserPaneFrame: _onBrowserPaneFrame, ...bridge } = api;
contextBridge.exposeInMainWorld("ompBackend", bridge satisfies DesktopBackendBridge);

if (window === window.top) {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data !== DESKTOP_PANE_WINDOW_REQUEST) return;
    ipcRenderer.send(DESKTOP_PANE_PORT_REQUEST);
  });
  ipcRenderer.on(DESKTOP_PANE_PORT, (event) => {
    if (event.ports.length !== 1) {
      for (const port of event.ports) port.close();
      return;
    }
    window.postMessage(DESKTOP_PANE_WINDOW_PORT, "*", event.ports);
  });
}
