import { contextBridge, ipcRenderer } from "electron";
import type { OmpBackend } from "@omp-ui/core";
import { CH } from "../main/channels";

// contextIsolation on, never expose ipcRenderer itself: every listener wraps
// away the IpcRendererEvent so it can't leak into the renderer.
const api: OmpBackend = {
  getState: () => ipcRenderer.invoke(CH.stateGet),
  addProject: (path) => ipcRenderer.invoke(CH.projectAdd, path),
  browseDirectories: (partialPath) => ipcRenderer.invoke(CH.dirBrowse, partialPath),
  removeProject: (path) => ipcRenderer.invoke(CH.projectRemove, path),
  setDefaultMode: (mode) => ipcRenderer.invoke(CH.settingsSetDefaultMode, mode),
  setSkipDeleteConfirmation: (skip) =>
    ipcRenderer.invoke(CH.settingsSetSkipDeleteConfirmation, skip),
  setThemeId: (id) => ipcRenderer.invoke(CH.settingsSetThemeId, id),
  setAppUpdateCheckOnLaunch: (on) =>
    ipcRenderer.invoke(CH.settingsSetAppUpdateCheckOnLaunch, on),
  setOmpUpdateCheckOnLaunch: (on) =>
    ipcRenderer.invoke(CH.settingsSetOmpUpdateCheckOnLaunch, on),
  clearDismissedAppUpdate: () => ipcRenderer.invoke(CH.settingsClearDismissedAppUpdate),
  clearDismissedOmpUpdate: () => ipcRenderer.invoke(CH.settingsClearDismissedOmpUpdate),
  setWindowChrome: (background, symbol) =>
    ipcRenderer.invoke(CH.windowSetChrome, background, symbol),
  readOmpSettings: (projectCwd) => ipcRenderer.invoke(CH.ompSettingsRead, projectCwd),
  writeOmpSetting: (key, value) => ipcRenderer.invoke(CH.ompSettingsWrite, key, value),
  readProviderKeys: (projectCwd) => ipcRenderer.invoke(CH.providerKeysRead, projectCwd),
  setProviderKey: (envName, value) => ipcRenderer.invoke(CH.providerKeysSet, envName, value),
  clearProviderKey: (envName) => ipcRenderer.invoke(CH.providerKeysClear, envName),
  spawnSession: (req) => ipcRenderer.invoke(CH.sessionSpawn, req),
  terminateSession: (tabId) => ipcRenderer.invoke(CH.sessionTerminate, tabId),
  switchMode: (tabId, mode) => ipcRenderer.invoke(CH.sessionSwitchMode, tabId, mode),
  deleteSession: (tabId) => ipcRenderer.invoke(CH.sessionDelete, tabId),
  forkSession: (tabId) => ipcRenderer.invoke(CH.sessionFork, tabId),
  setSessionAdvisor: (tabId, advisor, advisorModel) =>
    ipcRenderer.invoke(CH.sessionSetAdvisor, tabId, advisor, advisorModel),
  getAdvisorDefaults: (projectCwd) => ipcRenderer.invoke(CH.advisorDefaults, projectCwd),
  setSessionModel: (tabId, model, thinkingLevel) =>
    ipcRenderer.invoke(CH.sessionSetModel, tabId, model, thinkingLevel),
  generateTitle: (projectCwd, prompt) =>
    ipcRenderer.invoke(CH.titleGenerate, projectCwd, prompt),
  readPlanFile: (tabId, absPath) => ipcRenderer.invoke(CH.planRead, tabId, absPath),
  openPath: (absPath) => ipcRenderer.invoke(CH.fileOpen, absPath),
  showPathInFolder: (absPath) => ipcRenderer.invoke(CH.fileShowInFolder, absPath),
  getBranchDiff: (projectCwd) => ipcRenderer.invoke(CH.branchDiff, projectCwd),
  listBranches: (projectCwd) => ipcRenderer.invoke(CH.branchList, projectCwd),
  checkoutBranch: (projectCwd, name, opts) =>
    ipcRenderer.invoke(CH.branchCheckout, projectCwd, name, opts),
  suggestBranchName: (projectCwd, planContext) =>
    ipcRenderer.invoke(CH.branchNameSuggest, projectCwd, planContext),
  getMcpServers: (projectCwd) => ipcRenderer.invoke(CH.mcpList, projectCwd),
  setMcpServerEnabled: (req) => ipcRenderer.invoke(CH.mcpSetEnabled, req),
  restartSession: (tabId) => ipcRenderer.invoke(CH.sessionRestart, tabId),
  listProjectFiles: (projectCwd) => ipcRenderer.invoke(CH.projectFilesList, projectCwd),
  resolveFileMentions: (projectCwd, message) =>
    ipcRenderer.invoke(CH.fileMentionsResolve, projectCwd, message),
  ptyPasteImage: (tabId, image) => ipcRenderer.invoke(CH.ptyPasteImage, tabId, image),
  ptyWrite: (tabId, data) => ipcRenderer.send(CH.ptyWrite, tabId, data),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send(CH.ptyResize, tabId, cols, rows),
  shellSpawn: (tabId, cwd, cols, rows) =>
    ipcRenderer.invoke(CH.shellSpawn, tabId, cwd, cols, rows),
  shellKill: (tabId) => ipcRenderer.send(CH.shellKill, tabId),
  shellWrite: (tabId, data) => ipcRenderer.send(CH.shellWrite, tabId, data),
  shellResize: (tabId, cols, rows) => ipcRenderer.send(CH.shellResize, tabId, cols, rows),
  onShellData: (cb) =>
    ipcRenderer.on(CH.shellData, (_e, tabId: string, data: Uint8Array) => cb(tabId, data)),
  onShellExit: (cb) =>
    ipcRenderer.on(CH.shellExit, (_e, tabId: string, exitCode: number) => cb(tabId, exitCode)),
  rpcSend: (tabId, command) => ipcRenderer.send(CH.rpcSend, tabId, command),
  onPtyData: (cb) =>
    ipcRenderer.on(CH.ptyData, (_e, tabId: string, data: Uint8Array) => cb(tabId, data)),
  onPtyExit: (cb) =>
    ipcRenderer.on(CH.ptyExit, (_e, tabId: string, exitCode: number) => cb(tabId, exitCode)),
  onRpcFrame: (cb) =>
    ipcRenderer.on(CH.rpcFrame, (_e, tabId: string, frame: object) => cb(tabId, frame)),
  onStateChanged: (cb) => ipcRenderer.on(CH.stateChanged, (_e, state) => cb(state)),
  toggleFavorite: (key) => ipcRenderer.invoke(CH.favoritesToggle, key),
  getOmpUpdateState: () => ipcRenderer.invoke(CH.ompUpdateGetState),
  checkOmpUpdate: () => ipcRenderer.invoke(CH.ompUpdateCheck),
  downloadOmpUpdate: () => ipcRenderer.invoke(CH.ompUpdateDownload),
  dismissOmpUpdate: (version, remember) =>
    ipcRenderer.invoke(CH.ompUpdateDismiss, version, remember),
  onOmpUpdateState: (cb) =>
    ipcRenderer.on(CH.ompUpdateState, (_e, state) => cb(state)),
  getAppUpdateState: () => ipcRenderer.invoke(CH.appUpdateGetState),
  checkAppUpdate: () => ipcRenderer.invoke(CH.appUpdateCheck),
  downloadAppUpdate: () => ipcRenderer.invoke(CH.appUpdateDownload),
  openAppUpdateReleaseNotes: () => ipcRenderer.invoke(CH.appUpdateOpenNotes),
  showAppUpdateDownload: () => ipcRenderer.invoke(CH.appUpdateShowDownload),
  restartForAppUpdate: () => ipcRenderer.invoke(CH.appUpdateRestart),
  dismissAppUpdate: (version, remember) =>
    ipcRenderer.invoke(CH.appUpdateDismiss, version, remember),
  onAppUpdateState: (cb) =>
    ipcRenderer.on(CH.appUpdateState, (_e, state) => cb(state)),
  getRemoteState: () => ipcRenderer.invoke(CH.remoteGetState),
  setRemoteEnabled: (on) => ipcRenderer.invoke(CH.remoteSetEnabled, on),
  setRemoteBind: (bind) => ipcRenderer.invoke(CH.remoteSetBind, bind),
  setRemotePort: (port) => ipcRenderer.invoke(CH.remoteSetPort, port),
  regenerateRemoteToken: () => ipcRenderer.invoke(CH.remoteRegenerateToken),
  onRemoteState: (cb) => ipcRenderer.on(CH.remoteState, (_e, state) => cb(state)),
};

contextBridge.exposeInMainWorld("ompBackend", api);
