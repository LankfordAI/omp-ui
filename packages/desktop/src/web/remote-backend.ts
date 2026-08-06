import type { OmpBackend } from "@omp-ui/core/types";
import { decodeBinaryEvent, REMOTE_TOKEN_PARAM, REMOTE_WS_PATH } from "@omp-ui/server/protocol";
import { CH } from "../main/channels";

// The browser half of the remote transport (issue #37). This is preload/index.ts's twin: every
// ipcRenderer.invoke becomes req(), every .send becomes notify(), every .on becomes on(). No
// channel is filtered — the issue specifies one authenticated capability level, identical to the
// local user. Reaching into ../main/channels is the same reach the preload already does;
// channels.ts is a bare `as const` object with no imports.

type Listener = (...args: unknown[]) => void;

export interface RemoteConnection {
  backend: OmpBackend;
  /** Fires `false` on close/error, `true` on open. Registration is fire-once, like preload. */
  onStatus(cb: (up: boolean) => void): void;
}

function socketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(location.search).get(REMOTE_TOKEN_PARAM);
  // The cookie covers the normal case; the query keeps a cold load working.
  const query = token === null || token === "" ? "" : `?${REMOTE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
  return `${scheme}//${location.host}${REMOTE_WS_PATH}${query}`;
}

export function connectRemoteBackend(): Promise<RemoteConnection> {
  const ws = new WebSocket(socketUrl());
  ws.binaryType = "arraybuffer";

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Listener[]>();
  const statusCbs: Array<(up: boolean) => void> = [];
  let nextId = 1;
  let opened = false;

  const dispatch = (channel: string, args: unknown[]): void => {
    for (const cb of listeners.get(channel) ?? []) cb(...args);
  };

  ws.addEventListener("message", (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      const decoded = decodeBinaryEvent(new Uint8Array(ev.data));
      if (decoded) dispatch(decoded.channel, [decoded.tabId, decoded.payload]);
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (frame === null || typeof frame !== "object") return;
    const f = frame as { t?: unknown; id?: unknown; ch?: unknown; ok?: unknown; value?: unknown; message?: unknown; args?: unknown };
    if (f.t === "ev" && typeof f.ch === "string") {
      dispatch(f.ch, Array.isArray(f.args) ? f.args : []);
      return;
    }
    if (f.t !== "res" || typeof f.id !== "number") return;
    const entry = pending.get(f.id);
    if (!entry) return;
    pending.delete(f.id);
    if (f.ok === true) entry.resolve(f.value);
    else entry.reject(new Error(typeof f.message === "string" ? f.message : "remote call failed"));
  });

  const req = <T>(ch: string, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error("remote connection lost"));
        return;
      }
      const id = nextId++;
      // No timeout, matching IPC: a long-running handler is not a failure. The close handler
      // below is what settles anything still outstanding.
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ t: "req", id, ch, args }));
    });

  const notify = (ch: string, ...args: unknown[]): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "notify", ch, args }));
  };

  const on = (ch: string, cb: Listener): void => {
    const list = listeners.get(ch);
    if (list) list.push(cb);
    else listeners.set(ch, [cb]);
  };

  const backend: OmpBackend = {
    getState: () => req(CH.stateGet),
    addProject: (path) => req(CH.projectAdd, path),
    browseDirectories: (partialPath) => req(CH.dirBrowse, partialPath),
    removeProject: (path) => req(CH.projectRemove, path),
    setDefaultMode: (mode) => req(CH.settingsSetDefaultMode, mode),
    setSkipDeleteConfirmation: (skip) => req(CH.settingsSetSkipDeleteConfirmation, skip),
    setThemeId: (id) => req(CH.settingsSetThemeId, id),
    setAppUpdateCheckOnLaunch: (on) => req(CH.settingsSetAppUpdateCheckOnLaunch, on),
    setOmpUpdateCheckOnLaunch: (on) => req(CH.settingsSetOmpUpdateCheckOnLaunch, on),
    clearDismissedAppUpdate: () => req(CH.settingsClearDismissedAppUpdate),
    clearDismissedOmpUpdate: () => req(CH.settingsClearDismissedOmpUpdate),
    setWindowChrome: (background, symbol) => req(CH.windowSetChrome, background, symbol),
    readOmpSettings: (projectCwd) => req(CH.ompSettingsRead, projectCwd),
    writeOmpSetting: (key, value) => req(CH.ompSettingsWrite, key, value),
    readProviderKeys: (projectCwd) => req(CH.providerKeysRead, projectCwd),
    setProviderKey: (envName, value) => req(CH.providerKeysSet, envName, value),
    clearProviderKey: (envName) => req(CH.providerKeysClear, envName),
    spawnSession: (r) => req(CH.sessionSpawn, r),
    terminateSession: (tabId) => req(CH.sessionTerminate, tabId),
    switchMode: (tabId, mode) => req(CH.sessionSwitchMode, tabId, mode),
    deleteSession: (tabId) => req(CH.sessionDelete, tabId),
    forkSession: (tabId) => req(CH.sessionFork, tabId),
    setSessionAdvisor: (tabId, advisor, advisorModel) =>
      req(CH.sessionSetAdvisor, tabId, advisor, advisorModel),
    getAdvisorDefaults: (projectCwd) => req(CH.advisorDefaults, projectCwd),
    setSessionModel: (tabId, model, thinkingLevel) =>
      req(CH.sessionSetModel, tabId, model, thinkingLevel),
    generateTitle: (projectCwd, prompt) => req(CH.titleGenerate, projectCwd, prompt),
    readPlanFile: (tabId, absPath) => req(CH.planRead, tabId, absPath),
    openPath: (absPath) => req(CH.fileOpen, absPath),
    showPathInFolder: (absPath) => req(CH.fileShowInFolder, absPath),
    getBranchDiff: (projectCwd) => req(CH.branchDiff, projectCwd),
    listBranches: (projectCwd) => req(CH.branchList, projectCwd),
    checkoutBranch: (projectCwd, name, opts) => req(CH.branchCheckout, projectCwd, name, opts),
    suggestBranchName: (projectCwd, planContext) =>
      req(CH.branchNameSuggest, projectCwd, planContext),
    getMcpServers: (projectCwd) => req(CH.mcpList, projectCwd),
    setMcpServerEnabled: (r) => req(CH.mcpSetEnabled, r),
    restartSession: (tabId) => req(CH.sessionRestart, tabId),
    listProjectFiles: (projectCwd) => req(CH.projectFilesList, projectCwd),
    resolveFileMentions: (projectCwd, message) => req(CH.fileMentionsResolve, projectCwd, message),
    ptyPasteImage: (tabId, image) => req(CH.ptyPasteImage, tabId, image),
    ptyWrite: (tabId, data) => notify(CH.ptyWrite, tabId, data),
    ptyResize: (tabId, cols, rows) => notify(CH.ptyResize, tabId, cols, rows),
    shellSpawn: (tabId, cwd, cols, rows) => req(CH.shellSpawn, tabId, cwd, cols, rows),
    shellKill: (tabId) => notify(CH.shellKill, tabId),
    shellWrite: (tabId, data) => notify(CH.shellWrite, tabId, data),
    shellResize: (tabId, cols, rows) => notify(CH.shellResize, tabId, cols, rows),
    onShellData: (cb) =>
      on(CH.shellData, (tabId, data) => cb(tabId as string, data as Uint8Array)),
    onShellExit: (cb) =>
      on(CH.shellExit, (tabId, exitCode) => cb(tabId as string, exitCode as number)),
    rpcSend: (tabId, command) => notify(CH.rpcSend, tabId, command),
    onPtyData: (cb) => on(CH.ptyData, (tabId, data) => cb(tabId as string, data as Uint8Array)),
    onPtyExit: (cb) =>
      on(CH.ptyExit, (tabId, exitCode) => cb(tabId as string, exitCode as number)),
    onRpcFrame: (cb) => on(CH.rpcFrame, (tabId, frame) => cb(tabId as string, frame as object)),
    onStateChanged: (cb) => on(CH.stateChanged, (state) => cb(state as never)),
    toggleFavorite: (key) => req(CH.favoritesToggle, key),
    getOmpUpdateState: () => req(CH.ompUpdateGetState),
    checkOmpUpdate: () => req(CH.ompUpdateCheck),
    downloadOmpUpdate: () => req(CH.ompUpdateDownload),
    dismissOmpUpdate: (version, remember) => req(CH.ompUpdateDismiss, version, remember),
    onOmpUpdateState: (cb) => on(CH.ompUpdateState, (state) => cb(state as never)),
    getAppUpdateState: () => req(CH.appUpdateGetState),
    checkAppUpdate: () => req(CH.appUpdateCheck),
    downloadAppUpdate: () => req(CH.appUpdateDownload),
    openAppUpdateReleaseNotes: () => req(CH.appUpdateOpenNotes),
    showAppUpdateDownload: () => req(CH.appUpdateShowDownload),
    restartForAppUpdate: () => req(CH.appUpdateRestart),
    setAppUpdateInstallOnQuit: (on) => req(CH.appUpdateInstallOnQuit, on),
    dismissAppUpdate: (version, remember) => req(CH.appUpdateDismiss, version, remember),
    onAppUpdateState: (cb) => on(CH.appUpdateState, (state) => cb(state as never)),
    getRemoteState: () => req(CH.remoteGetState),
    setRemoteEnabled: (value) => req(CH.remoteSetEnabled, value),
    setRemoteBind: (bind) => req(CH.remoteSetBind, bind),
    setRemotePort: (port) => req(CH.remoteSetPort, port),
    regenerateRemoteToken: () => req(CH.remoteRegenerateToken),
    onRemoteState: (cb) => on(CH.remoteState, (state) => cb(state as never)),
  };

  return new Promise<RemoteConnection>((resolve, reject) => {
    ws.addEventListener("open", () => {
      opened = true;
      for (const cb of statusCbs) cb(true);
      resolve({
        backend,
        onStatus(cb) {
          statusCbs.push(cb);
        },
      });
    });
    const down = (): void => {
      for (const cb of statusCbs) cb(false);
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      if (!opened) {
        reject(
          new Error("could not reach omp-ui — check the token and that remote access is enabled"),
        );
      }
    };
    ws.addEventListener("close", down);
    ws.addEventListener("error", () => {
      // A pre-open error is always followed by close, which is where the reject lives; this
      // handler exists so the event is not reported as unhandled.
      if (opened) down();
    });
  });
}
