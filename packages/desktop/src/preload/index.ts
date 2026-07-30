import { contextBridge, ipcRenderer } from "electron";
import type { OmpBackend } from "@omp-ui/core";
import { CH } from "../main/channels";

// contextIsolation on, never expose ipcRenderer itself: every listener wraps
// away the IpcRendererEvent so it can't leak into the renderer.
const api: OmpBackend = {
  getState: () => ipcRenderer.invoke(CH.stateGet),
  addProject: () => ipcRenderer.invoke(CH.projectAdd),
  removeProject: (path) => ipcRenderer.invoke(CH.projectRemove, path),
  setDefaultMode: (mode) => ipcRenderer.invoke(CH.settingsSetDefaultMode, mode),
  spawnSession: (req) => ipcRenderer.invoke(CH.sessionSpawn, req),
  terminateSession: (tabId) => ipcRenderer.invoke(CH.sessionTerminate, tabId),
  switchMode: (tabId, mode) => ipcRenderer.invoke(CH.sessionSwitchMode, tabId, mode),
  deleteSession: (tabId) => ipcRenderer.invoke(CH.sessionDelete, tabId),
  setSessionAdvisor: (tabId, advisor, advisorModel) =>
    ipcRenderer.invoke(CH.sessionSetAdvisor, tabId, advisor, advisorModel),
  getAdvisorDefaults: (projectCwd) => ipcRenderer.invoke(CH.advisorDefaults, projectCwd),
  ptyPasteImage: (tabId, image) => ipcRenderer.invoke(CH.ptyPasteImage, tabId, image),
  ptyWrite: (tabId, data) => ipcRenderer.send(CH.ptyWrite, tabId, data),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send(CH.ptyResize, tabId, cols, rows),
  rpcSend: (tabId, command) => ipcRenderer.send(CH.rpcSend, tabId, command),
  onPtyData: (cb) =>
    ipcRenderer.on(CH.ptyData, (_e, tabId: string, data: Uint8Array) => cb(tabId, data)),
  onPtyExit: (cb) =>
    ipcRenderer.on(CH.ptyExit, (_e, tabId: string, exitCode: number) => cb(tabId, exitCode)),
  onRpcFrame: (cb) =>
    ipcRenderer.on(CH.rpcFrame, (_e, tabId: string, frame: object) => cb(tabId, frame)),
  onStateChanged: (cb) => ipcRenderer.on(CH.stateChanged, (_e, state) => cb(state)),
};

contextBridge.exposeInMainWorld("ompBackend", api);
