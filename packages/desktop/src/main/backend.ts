import * as fs from "node:fs";
import * as path from "node:path";
import { app, ipcMain, shell, type BrowserWindow } from "electron";
import {
  CH,
  addMemory,
  browseDirectories,
  checkoutBranch,
  forgetMemory,
  formatModelRole,
  generateBranchNameWithOmp,
  generateTitleWithOmp,
  getArchiveRoot,
  getMemory,
  getSessionsRoot,
  hydrateSessionFile,
  readOmpAdvisorDefaults,
  readOmpModelRole,
  readOmpSettings,
  readBranchDiff,
  listBranches,
  listMemories,
  readMemoryOverview,
  pullBranch,
  mintWorktreePath,
  isWithin,
  removeWorktree,
  listProjectFiles,
  resolveFileMentions,
  resolveMcpServers,
  resolveProjectPath,
  resolveGlobalBank,
  resolveMemoryBase,
  resolveProjectBank,
  setMcpServerEnabled,
  ProviderKeys,
  Registry,
  resolveOmpBinary,
  resolveSessionLocation,
  writeOmpSetting,
  updateMemory,
  type AgentMode,
  TITLE_MODEL_ROLES,
  type AdvisorDefaults,
  type BackendState,
  type ChannelTable,
  type BranchListOptions,
  type ImageAttachment,
  type McpSetEnabledRequest,
  type LiveState,
  type MemoryListOptions,
  type MemoryScope,
  type OmpSettingValue,
  type OwnedSessionRecord,
  type PlanFormat,
  type ProjectGroup,
  type ProjectOpenTarget,
  type ProviderKeysSnapshot,
  type RemoteBind,
  type ResolvedBank,
  type SessionMode,
  type SessionSummary,
  type SpawnRequest,
} from "@omp-ui/core";
import { hashRemotePassword, mintRemoteToken, validateRemotePassword } from "@omp-ui/server";
import { OmpUpdater } from "./omp-update";
import { AppUpdater } from "./app-update";
import { RemoteServerManager } from "./remote-server";
import { SessionManager } from "./session-manager";
import { electronKeyCipher } from "./key-cipher";
import { ProjectOpener } from "./project-open";

/**
 * Resolves the memory bank the renderer is allowed to touch. The renderer
 * never passes a db path — confinement mirrors the plan:read discipline
 * (ADR-0007): a compromised renderer can only reach the two banks its
 * project legitimately owns.
 */
function requireBank(projectCwd: string, scope: MemoryScope): ResolvedBank {
  const base = resolveMemoryBase(projectCwd);
  if (base.backend !== "mnemopi") throw new Error("memory backend is not mnemopi");
  if (scope === "global") return resolveGlobalBank(base);
  const bank = resolveProjectBank(base, projectCwd);
  if (bank === null) throw new Error(`no project memory bank for ${projectCwd}`);
  return bank;
}

/** Owns application state and delegates every live child to SessionManager. */
export class MainBackend {
  /** Serializes each complete state build and delivery so an older snapshot can never overtake a newer one. */
  private broadcastChain: Promise<void> = Promise.resolve();
  private readonly registry: Registry;
  private ompPath = resolveOmpBinary();
  readonly sessions: SessionManager;
  private readonly appUpdater: AppUpdater;
  private readonly ompUpdater: OmpUpdater;
  private readonly remote: RemoteServerManager;
  private readonly projectOpener = new ProjectOpener();
  /**
   * Provider credentials for every omp launch. Constructed before any spawn
   * path can run and applied immediately, so even the first session sees the
   * stored keys; the login-shell capture is awaited separately at boot.
   */
  private readonly providerKeys: ProviderKeys;
  /** Where worktree checkouts live; defaults beside the registry. */
  private readonly worktreesRoot: string;

  constructor(
    private readonly win: BrowserWindow,
    registryFile: string,
    opts: {
      setAppUpdateQuitAuthorized?: (on: boolean) => void;
      appUpdateEnabled?: boolean;
      appVersion?: string;
      appUpdateEnv?: NodeJS.ProcessEnv;
      /** Directory holding the built browser bundle for remote clients (out/web). */
      webRoot?: string;
      /** Where provider credentials are stored; defaults beside the registry. */
      providerKeysFile?: string;
      /** Where worktree checkouts live; defaults beside the registry. */
      worktreesRoot?: string;
      /** Process owner override for focused main-process tests. */
      sessions?: SessionManager;
    } = {},
  ) {
    this.registry = Registry.load(registryFile);
    // Applied in the constructor, not at boot: spawn() must never be reachable
    // with a keyless environment, and the login-shell capture (boot, async) only
    // ever adds to what is already installed here.
    this.providerKeys = new ProviderKeys(
      opts.providerKeysFile ?? path.join(path.dirname(registryFile), "provider-keys.json"),
      electronKeyCipher(),
    );
    this.providerKeys.applyToProcessEnv();
    this.worktreesRoot =
      opts.worktreesRoot ?? path.join(path.dirname(registryFile), "worktrees");
    this.sessions =
      opts.sessions ??
      new SessionManager({
        registry: this.registry,
        providerKeys: this.providerKeys,
        getOmpPath: () => this.ompPath,
        getSessionsRoot: () => this.sessionsRoot,
        getArchiveRoot: () => this.archiveRoot,
        getWorktreesRoot: () => this.worktreesRoot,
        send: (channel, ...args) => this.send(channel, ...args),
        broadcast: () => this.broadcast(),
      });
    // The desktop window is one event mirror among several — the remote server adds its own.
    // Guarded here rather than in send(): on/after quit the webContents is gone.
    this.addSink((channel, args) => {
      if (this.win.isDestroyed()) return;
      const wc = this.win.webContents;
      // A crashed renderer is not "destroyed" — sending into it throws
      // "Render frame was disposed …" once per frame until the app is killed
      // (issue #183).
      if (wc.isDestroyed() || wc.isCrashed()) return;
      try {
        wc.send(channel, ...args);
      } catch (err) {
        this.noteSinkFailure(err);
      }
    });
    this.appUpdater = new AppUpdater({
      win,
      enabled: opts.appUpdateEnabled ?? app.isPackaged,
      currentVersion: opts.appVersion ?? app.getVersion(),
      env: opts.appUpdateEnv,
      downloadsDir: app.getPath("downloads"),
      getDismissed: () => this.registry.dismissedAppUpdateVersion,
      setDismissed: (v) => this.registry.setDismissedAppUpdateVersion(v),
      hasLiveSessions: () => this.sessions.liveCount > 0,
      setQuitAuthorized: opts.setAppUpdateQuitAuthorized ?? (() => {}),
      send: (ch, s) => this.send(ch, s),
      channel: CH.onAppUpdateState,
    });
    this.ompUpdater = new OmpUpdater({
      getDismissed: () => this.registry.dismissedOmpUpdateVersion,
      setDismissed: (v) => this.registry.setDismissedOmpUpdateVersion(v),
      onApplied: () => this.refreshOmpPath(),
      send: (ch, s) => this.send(ch, s),
      channel: CH.onOmpUpdateState,
    });
    // Mint at construction so the settings page always has a token to reveal, even before the
    // server is first enabled.
    if (this.registry.remoteToken === "") this.registry.setRemoteToken(mintRemoteToken());
    this.remote = new RemoteServerManager({
      host: { handlers: () => this.handlers(), addSink: (s) => this.addSink(s) },
      webRoot: opts.webRoot ?? "",
      getSettings: () => ({
        enabled: this.registry.remoteEnabled,
        bind: this.registry.remoteBind,
        port: this.registry.remotePort,
        token: this.registry.remoteToken,
        passwordHash: this.registry.remotePasswordHash,
        passwordSalt: this.registry.remotePasswordSalt,
      }),
      setToken: (token) => this.registry.setRemoteToken(token),
      send: (state) => this.send(CH.onRemoteState, state),
    });
  }

  get liveCount(): number {
    return this.sessions.liveCount;
  }


  /**
   * Re-resolves the omp binary after an install/update so the fresh managed
   * copy (which ranks above PATH) is picked up without an app restart.
   */
  refreshOmpPath(): void {
    this.ompPath = resolveOmpBinary();
  }

  // Resolved lazily at every use — the XDG branch is existence-gated and can
  // flip while the app runs.
  private get sessionsRoot(): string {
    return getSessionsRoot();
  }

  private get archiveRoot(): string {
    return getArchiveRoot(this.sessionsRoot);
  }

  private readonly sinks = new Set<(channel: string, args: unknown[]) => void>();

  /** Registers an extra event mirror (the remote server). Returns its unsubscribe. */
  addSink(sink: (channel: string, args: unknown[]) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  private send(channel: string, ...args: unknown[]): void {
    for (const sink of this.sinks) sink(channel, args);
  }

  private sinkFailureLastLog = 0;

  /** Rate-limited warn for window-sink failures — a dead renderer must not spam. */
  private noteSinkFailure(err: unknown): void {
    const now = Date.now();
    if (now - this.sinkFailureLastLog < 60_000) return;
    this.sinkFailureLastLog = now;
    console.warn(
      `[backend] window sink send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /**
   * Every channel's implementation, transport-agnostic: Electron IPC binds these below and the
   * remote WebSocket server dispatches the same table (issue #37).
   */
  handlers(): ChannelTable {
    return {
      request: {
        [CH.getState]: () => this.buildState(),
        [CH.addProject]: async (raw: string) => {
          const resolved = await resolveProjectPath(raw);
          const record = this.registry.addProject(resolved);
          await this.broadcast();
          return record;
        },
        [CH.browseDirectories]: (partialPath: string) => browseDirectories(partialPath),
        [CH.removeProject]: async (projectPath: string) => {
          if (this.sessions.hasLiveInProject(projectPath)) {
            throw new Error("project has live sessions — terminate them first");
          }
          this.sessions.stopProjectWatchers(projectPath);
          const worktreePaths = new Set(
            this.registry.sessions
              .filter(
                (s) =>
                  s.projectCwd === projectPath &&
                  s.worktree &&
                  // Only the canonical minted path inside the worktrees
                  // root: a corrupt registry value must not steer the
                  // recursive fallback inside removeWorktree.
                  s.worktree.path ===
                    mintWorktreePath(this.worktreesRoot, projectPath, s.worktree.branch) &&
                  isWithin(this.worktreesRoot, s.worktree.path),
              )
              .map((s) => s.worktree!.path),
          );
          for (const wt of worktreePaths) {
            try { await removeWorktree(projectPath, wt); }
            catch (err) { console.warn(`[backend] worktree cleanup failed for ${wt}:`, err); }
          }
          this.registry.removeProject(projectPath);
          await this.broadcast();
        },
        // Reordering never touches process state, so unlike remove there is no
        // live-session guard; a null `beforePath` appends (issue #115).
        [CH.moveProject]: async (projectPath: string, beforePath: string | null) => {
          this.registry.moveProject(projectPath, beforePath ?? null);
          await this.broadcast();
        },
        [CH.setDefaultMode]: async (mode: SessionMode) => {
          this.registry.setDefaultMode(mode);
          await this.broadcast();
        },
        [CH.setDefaultAgentMode]: async (mode: AgentMode) => {
          this.registry.setDefaultAgentMode(mode);
          await this.broadcast();
        },
        [CH.setPlanFormat]: async (format: PlanFormat) => {
          this.registry.setPlanFormat(format);
          await this.broadcast();
        },
        [CH.setHibernateIdleMinutes]: async (minutes: number) => {
          this.registry.setHibernateIdleMinutes(minutes);
          await this.broadcast();
        },
        [CH.setAdvisorAutoReply]: async (on: boolean) => {
          this.registry.setAdvisorAutoReply(on);
          await this.broadcast();
        },
        [CH.setDefaultAdvisor]: async (on: boolean) => {
          this.registry.setDefaultAdvisor(on);
          await this.broadcast();
        },
        [CH.setSkipDeleteConfirmation]: async (skip: boolean) => {
          this.registry.setSkipDeleteConfirmation(skip);
          await this.broadcast();
        },
        [CH.setThemeId]: async (id: string) => {
          this.registry.setThemeId(id);
          await this.broadcast();
        },
        [CH.setAppUpdateCheckOnLaunch]: async (on: boolean) => {
          this.registry.setAppUpdateCheckOnLaunch(on);
          await this.broadcast();
        },
        [CH.setOmpUpdateCheckOnLaunch]: async (on: boolean) => {
          this.registry.setOmpUpdateCheckOnLaunch(on);
          await this.broadcast();
        },
        // The appUpdateDismiss/ompUpdateDismiss channels only ever set a dismissal;
        // re-arming a dismissed card from Settings needs its own pair.
        [CH.clearDismissedAppUpdate]: async () => {
          this.registry.setDismissedAppUpdateVersion(null);
          await this.broadcast();
        },
        [CH.clearDismissedOmpUpdate]: async () => {
          this.registry.setDismissedOmpUpdateVersion(null);
          await this.broadcast();
        },
        [CH.toggleFavorite]: async (key: string) => {
          this.registry.toggleFavorite(key);
          await this.broadcast();
        },
        [CH.setSessionModel]: (tabId: string, model: string | null, thinkingLevel: string | null) => {
          this.registry.setSessionModel(tabId, model, thinkingLevel);
          void this.broadcast();
        },
        [CH.spawnSession]: (req: SpawnRequest) => this.sessions.spawn(req),
        [CH.terminateSession]: (tabId: string) => this.sessions.terminate(tabId),
        [CH.switchMode]: (tabId: string, mode: SessionMode) =>
          this.sessions.switchMode(tabId, mode),
        [CH.deleteSession]: (tabId: string) => this.sessions.deleteSession(tabId),
        [CH.forkSession]: (tabId: string) => this.sessions.forkSession(tabId),
        [CH.convertToWorktree]: (tabId: string, branch: string, baseRef: string | null) =>
          this.sessions.convertToWorktree(tabId, branch, baseRef),
        [CH.setSessionAdvisor]: (
          tabId: string,
          advisor: boolean,
          advisorModel: string | null,
          startInPlanMode: boolean,
        ) => this.sessions.setSessionAdvisor(tabId, advisor, advisorModel, startInPlanMode),
        [CH.getAdvisorDefaults]: (projectCwd: string): AdvisorDefaults =>
          this.advisorDefaults(projectCwd),
        [CH.generateTitle]: (projectCwd: string, prompt: string) =>
          this.generateTitle(projectCwd, prompt),
        [CH.readPlanFile]: (tabId: string, absPath: string) => this.readPlanFile(tabId, absPath),
        [CH.getProjectOpenAvailability]: () => this.projectOpener.availability(),
        [CH.openProject]: (projectPath: string, target: ProjectOpenTarget) =>
          this.projectOpener.open(projectPath, target),
        // shell.openPath resolves with an error string on failure ("" on
        // success); rejecting lets the renderer surface it instead of the
        // click dying silently.
        [CH.openPath]: async (absPath: string) => {
          const failure = await shell.openPath(absPath);
          if (failure !== "") throw new Error(failure);
        },
        [CH.showPathInFolder]: (absPath: string) => {
          shell.showItemInFolder(absPath);
        },
        [CH.getBranchDiff]: (projectCwd: string) => readBranchDiff(projectCwd),
        // Stateless core calls: branch operations touch no registry/BackendState field,
        // so these handlers never broadcast().
        [CH.listBranches]: (projectCwd: string, opts?: BranchListOptions) =>
          listBranches(projectCwd, opts),
        [CH.checkoutBranch]: (projectCwd: string, name: string, opts?: { create?: boolean }) =>
          checkoutBranch(projectCwd, name, opts),
        [CH.pullBranch]: (projectCwd: string) => pullBranch(projectCwd),
        // Memory handlers are stateless core calls like getBranchDiff:
        // they touch no registry/BackendState field and never broadcast().
        [CH.memoryOverview]: (projectCwd: string) => readMemoryOverview(projectCwd),
        [CH.memoryList]: (projectCwd: string, scope: MemoryScope, opts: MemoryListOptions) =>
          listMemories(requireBank(projectCwd, scope), scope, opts),
        [CH.memoryGet]: (projectCwd: string, scope: MemoryScope, id: string) =>
          getMemory(requireBank(projectCwd, scope), id),
        [CH.memoryAdd]: (projectCwd: string, scope: MemoryScope, content: string) =>
          addMemory(requireBank(projectCwd, scope), scope, projectCwd, content),
        [CH.memoryUpdate]: (
          projectCwd: string,
          scope: MemoryScope,
          id: string,
          patch: { content?: string; importance?: number },
        ) => updateMemory(requireBank(projectCwd, scope), id, patch),
        [CH.memoryForget]: (projectCwd: string, scope: MemoryScope, id: string) =>
          forgetMemory(requireBank(projectCwd, scope), id),
        [CH.suggestBranchName]: (projectCwd: string, planContext: string) =>
          this.suggestBranchName(projectCwd, planContext),
        [CH.readOmpSettings]: (projectCwd: string | null) =>
          readOmpSettings({ ompPath: this.ompPath, projectCwd }),
        [CH.writeOmpSetting]: (key: string, value: OmpSettingValue) =>
          writeOmpSetting({ ompPath: this.ompPath, key, value }),
        // Each write answers with the refreshed snapshot in the same round trip,
        // so the page never has to guess what the store now holds.
        [CH.readProviderKeys]: (projectCwd: string | null) => this.providerSnapshot(projectCwd),
        [CH.setProviderKey]: (envName: string, value: string) => {
          this.providerKeys.setKey(envName, value);
          return this.providerSnapshot(null);
        },
        [CH.clearProviderKey]: (envName: string) => {
          this.providerKeys.clearKey(envName);
          return this.providerSnapshot(null);
        },
        [CH.setWindowChrome]: (background: string, symbol: string) => {
          if (this.win.isDestroyed()) return;
          try {
            this.win.setTitleBarOverlay({ color: background, symbolColor: symbol, height: 36 });
          } catch {
            // No overlay on this platform — a theme change must not surface a platform error.
          }
        },
        [CH.getMcpServers]: (projectCwd: string | null) => resolveMcpServers(projectCwd),
        [CH.setMcpServerEnabled]: (req: McpSetEnabledRequest) => setMcpServerEnabled(req),
        [CH.restartSession]: (tabId: string) => this.sessions.restart(tabId),
        [CH.listProjectFiles]: (projectCwd: string) => listProjectFiles(projectCwd),
        [CH.resolveFileMentions]: (projectCwd: string, message: string) =>
          resolveFileMentions(projectCwd, message),
        [CH.ptyPasteImage]: (tabId: string, image: ImageAttachment) =>
          this.sessions.ptyPasteImage(tabId, image),
        [CH.shellSpawn]: (tabId: string, cwd: string, cols: number, rows: number) =>
          this.sessions.launchShell(tabId, cwd, cols, rows),
        [CH.getOmpUpdateState]: () => this.ompUpdater.state,
        [CH.checkOmpUpdate]: () => this.ompUpdater.checkNow(true),
        [CH.downloadOmpUpdate]: () => this.ompUpdater.download(),
        [CH.dismissOmpUpdate]: (version: string, remember: boolean) =>
          this.ompUpdater.dismiss(version, remember),
        [CH.getAppUpdateState]: () => this.appUpdater.state,
        [CH.checkAppUpdate]: () => this.appUpdater.checkNow(true),
        [CH.downloadAppUpdate]: () => this.appUpdater.download(),
        [CH.openAppUpdateReleaseNotes]: () => this.appUpdater.openReleaseNotes(),
        [CH.showAppUpdateDownload]: () => this.appUpdater.showDownload(),
        [CH.restartForAppUpdate]: (confirmed = false) => this.appUpdater.restart(confirmed),
        [CH.setAppUpdateInstallOnQuit]: (on: boolean) => this.appUpdater.setInstallOnQuit(on),
        [CH.dismissAppUpdate]: (version: string, remember: boolean) =>
          this.appUpdater.dismiss(version, remember),
        [CH.getRemoteState]: () => this.remote.state,
        [CH.setRemoteEnabled]: async (on: boolean) => {
          this.registry.setRemoteEnabled(on);
          await this.remote.apply();
        },
        [CH.setRemoteBind]: async (bind: RemoteBind) => {
          this.registry.setRemoteBind(bind);
          await this.remote.apply();
        },
        [CH.setRemotePort]: async (port: number) => {
          if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new Error("port must be a whole number between 1024 and 65535");
          }
          this.registry.setRemotePort(port);
          await this.remote.apply();
        },
        [CH.regenerateRemoteToken]: async () => {
          this.registry.setRemoteToken(mintRemoteToken());
          await this.remote.restart();
        },
        [CH.setRemotePassword]: async (password: string) => {
          const problem = validateRemotePassword(password);
          if (problem !== null) throw new Error(problem);
          const { salt, hash } = hashRemotePassword(password);
          this.registry.setRemotePasswordHash(hash);
          this.registry.setRemotePasswordSalt(salt);
          // apply(), not restart(): the new hash/salt already makes sameTarget false.
          await this.remote.apply();
        },
        [CH.clearRemotePassword]: async () => {
          this.registry.setRemotePasswordHash("");
          this.registry.setRemotePasswordSalt("");
          await this.remote.apply();
        },
      },
      notify: {
        [CH.ptyWrite]: (tabId: string, data: string) => this.sessions.ptyWrite(tabId, data),
        [CH.ptyResize]: (tabId: string, cols: number, rows: number) =>
          this.sessions.ptyResize(tabId, cols, rows),
        [CH.shellKill]: (tabId: string) => this.sessions.killShell(tabId),
        [CH.shellWrite]: (tabId: string, data: string) => this.sessions.shellWrite(tabId, data),
        [CH.shellResize]: (tabId: string, cols: number, rows: number) =>
          this.sessions.shellResize(tabId, cols, rows),
        [CH.rpcSend]: (tabId: string, cmd: object) => this.sessions.rpcSend(tabId, cmd),
      },
    } satisfies ChannelTable;
  }

  registerIpc(): void {
    const { request, notify } = this.handlers();
    // Electron supplies dynamically decoded argument arrays, so widening happens once per table at
    // this transport boundary; individual handlers remain tuple-checked by ChannelTable.
    const requestHandlers = request as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const notifyHandlers = notify as unknown as Record<string, (...args: unknown[]) => void>;
    for (const [channel, handle] of Object.entries(requestHandlers)) {
      ipcMain.handle(channel, (_event, ...args: unknown[]) => handle(...args));
    }
    for (const [channel, handle] of Object.entries(notifyHandlers)) {
      ipcMain.on(channel, (_event, ...args: unknown[]) => handle(...args));
    }
  }

  /**
   * Launch-time background check — quiet unless an update is available. Gated
   * inside the method so no caller can bypass the user's launch preference;
   * the palette's manual check goes through checkNow(true) and stays live.
   */
  checkAppUpdateBackground(): void {
    if (!this.registry.appUpdateCheckOnLaunch) return;
    void this.appUpdater.checkNow(false);
  }

  /**
   * Launch-time background check — quiet unless an install/update offer
   * exists. Gated by the same launch preference as its app-update twin.
   */
  checkOmpUpdateBackground(): void {
    if (!this.registry.ompUpdateCheckOnLaunch) return;
    void this.ompUpdater.checkNow(false);
  }

  hydrateAll(): Promise<void> {
    return this.sessions.hydrateAll();
  }

  private providerSnapshot(projectCwd: string | null): ProviderKeysSnapshot {
    return {
      providers: this.providerKeys.statuses(projectCwd),
      encryptionAvailable: this.providerKeys.encryptionAvailable,
      backend: this.providerKeys.backend,
    };
  }

  /**
   * Recovers provider credentials the user exported from their shell rc, which a
   * .desktop/AppImage/dock launch never inherits — without this, omp starts with
   * no keys and its model catalog collapses to the providers needing none.
   *
   * Awaited at boot before the window can spawn a session; bounded to a few
   * seconds inside the capture, and a failure just leaves the environment as it
   * was, so a slow or hostile rc file cannot block startup.
   */
  captureShellKeys(): Promise<void> {
    return this.providerKeys.captureLoginShell();
  }

  /** Brings the embedded remote server in line with persisted settings. Called once at launch. */
  startRemote(): Promise<void> {
    return this.remote.apply();
  }

  killAll(): void {
    this.sessions.killAll();
    void this.remote.stop();
  }

  /**
   * Reads a plan artifact for the review pane. The path arrives from the
   * renderer, which got it from the agent's own plan slug, so it is confined to
   * the session's own lineage dir before any read — a crafted `local://`
   * name must not turn this channel into an arbitrary file reader.
   */
  private async readPlanFile(tabId: string, absPath: string): Promise<string | null> {
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return null;
    const root = path.resolve(this.sessionsRoot, record.lineageDir);
    const resolved = path.resolve(absPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      console.warn("[plan] refusing to read outside the lineage dir:", resolved);
      return null;
    }
    try {
      return await fs.promises.readFile(resolved, "utf8");
    } catch {
      // The agent may not have written the file yet — absent is not an error.
      return null;
    }
  }

  /** omp's own advisor defaults, so the composer can show what it inherits. */
  private advisorDefaults(projectCwd: string): AdvisorDefaults {
    const defaults = readOmpAdvisorDefaults(projectCwd);
    return {
      enabled: defaults.enabled,
      model: defaults.role === null ? null : formatModelRole(defaults.role),
    };
  }

  /**
   * Titles a prompt with omp's own small model. Null on every failure path —
   * no omp binary, a model the config names but the machine cannot reach, a
   * timeout, or a greeting the model declines to title. The renderer falls
   * back to its derived title, so this must never throw across IPC.
   */
  private async generateTitle(projectCwd: string, prompt: string): Promise<string | null> {
    if (!this.ompPath) return null;
    // The config's own role chain, so the title comes from whichever small
    // model the user already configured for omp's own titling.
    const role = readOmpModelRole(projectCwd, TITLE_MODEL_ROLES);
    try {
      return await generateTitleWithOmp({
        ompPath: this.ompPath,
        projectCwd,
        model: role === null ? null : formatModelRole(role),
        prompt,
      });
    } catch (err) {
      console.warn("[title] model titling failed:", err);
      return null;
    }
  }

  /**
   * Suggests a branch name for a plan with omp's own small model. Null on
   * every failure path — the renderer pre-fills its slug-derived name, so
   * this must never throw across IPC.
   */
  private async suggestBranchName(
    projectCwd: string,
    planContext: string,
  ): Promise<string | null> {
    if (!this.ompPath) return null;
    const role = readOmpModelRole(projectCwd, TITLE_MODEL_ROLES);
    try {
      return await generateBranchNameWithOmp({
        ompPath: this.ompPath,
        projectCwd,
        model: role === null ? null : formatModelRole(role),
        prompt: planContext,
      });
    } catch (err) {
      console.warn("[branch-name] model naming failed:", err);
      return null;
    }
  }

  private async buildState(): Promise<BackendState> {
    const records = this.registry.sessions;
    const groups: ProjectGroup[] = [];
    for (const project of this.registry.projects) {
      const sessions: SessionSummary[] = [];
      for (const record of records.filter((r) => r.projectCwd === project.path)) {
        sessions.push(await this.summarize(record));
      }
      sessions.sort((a, b) =>
        (b.cachedModified ?? b.launchedAt).localeCompare(a.cachedModified ?? a.launchedAt),
      );
      groups.push({ project, sessions });
    }
    // The registry array is the sidebar order (issue #115): `addProject`
    // appends, `moveProject` reorders, and nothing re-sorts here — otherwise a
    // drag would be silently undone for projects added at different times.
    return {
      projects: groups,
      defaultMode: this.registry.defaultMode,
      planFormat: this.registry.planFormat,
      hibernateIdleMinutes: this.registry.hibernateIdleMinutes,
      defaultAgentMode: this.registry.defaultAgentMode,
      advisorAutoReply: this.registry.advisorAutoReply,
      defaultAdvisor: this.registry.defaultAdvisor,
      modelFavorites: this.registry.getFavorites(),
      skipDeleteConfirmation: this.registry.skipDeleteConfirmation,
      themeId: this.registry.themeId,
      appUpdateCheckOnLaunch: this.registry.appUpdateCheckOnLaunch,
      ompUpdateCheckOnLaunch: this.registry.ompUpdateCheckOnLaunch,
      dismissedAppUpdateVersion: this.registry.dismissedAppUpdateVersion,
      dismissedOmpUpdateVersion: this.registry.dismissedOmpUpdateVersion,
    };
  }

  private async summarize(record: OwnedSessionRecord): Promise<SessionSummary> {
    const loc = await resolveSessionLocation(
      this.sessionsRoot,
      this.archiveRoot,
      record.lineageDir,
      record.sessionId,
    );
    const live: LiveState = this.sessions.isLive(record.tabId)
      ? "live"
      : loc.where === "active"
        ? "dormant"
        : loc.where === "archived"
          ? "archived"
          : "missing";
    let title = record.cachedTitle;
    let status: SessionSummary["status"] = null;
    if (loc.where === "active") {
      try {
        const h = await hydrateSessionFile(loc.filePath);
        if (h.title?.trim()) title = h.title;
        status = h.status;
        const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
        if (h.id && h.id !== record.sessionId) patch.sessionId = h.id;
        const headTitle = h.title?.trim() ? h.title : null;
        if (headTitle !== record.cachedTitle) patch.cachedTitle = headTitle;
        const modified = h.mtime.toISOString();
        if (modified !== record.cachedModified) patch.cachedModified = modified;
        if (Object.keys(patch).length > 0) {
          record = this.registry.updateSession(record.tabId, patch) ?? record;
        }
      } catch {
        // Vanished mid-hydrate — render from cached fields.
      }
    }
    const gate = this.sessions.planGate(record.tabId);
    return {
      ...record,
      title: title?.trim() || "New session",
      status,
      live,
      pendingPlan: gate?.pending ?? null,
      planSettle: gate?.settle ?? null,
    };
  }

  /** Fans state to every sink; the window sink self-guards, so remote clients survive a closed window. */
  private broadcast(): Promise<void> {
    const task = this.broadcastChain.then(async () => {
      const state = await this.buildState();
      this.send(CH.onStateChanged, state);
    });
    // Keep the queue usable after a failed build without changing the Promise
    // returned to this caller: `task` still carries its own rejection.
    this.broadcastChain = task.catch(() => {});
    return task;
  }
}
