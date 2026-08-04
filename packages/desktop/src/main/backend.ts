import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";
import {
  base64Bytes,
  bracketedImagePaste,
  browseDirectories,
  checkoutBranch,
  deleteSessionFiles,
  formatModelRole,
  generateTitleWithOmp,
  getArchiveRoot,
  getSessionsRoot,
  hydrateSessionFile,
  mintLineageDirName,
  parseModelRole,
  readOmpAdvisorDefaults,
  readOmpModelRole,
  readBranchDiff,
  listBranches,
  listProjectFiles,
  resolveFileMentions,
  resolveMcpServers,
  resolveProjectPath,
  setMcpServerEnabled,
  Registry,
  resolveOmpBinary,
  resolveSessionLocation,
  RpcClient,
  spawnOmp,
  unarchiveSession,
  watchLineageDir,
  writeAdvisorOverlay,
  writeDefaultModelOverlay,
  writePlanExtension,
  writeAdvisorStatsExtension,
  writeImageToScratch,
  MAX_IMAGE_BYTES,
  TITLE_MODEL_ROLES,
  type AdvisorDefaults,
  type BackendState,
  type ImageAttachment,
  type LiveState,
  type McpSetEnabledRequest,
  type OwnedSessionRecord,
  type ProjectGroup,
  type PtyHandle,
  type SessionMode,
  type SessionSummary,
  type SpawnRequest,
} from "@omp-ui/core";
import { OmpUpdater } from "./omp-update";
import { AppUpdater } from "./app-update";
import { CH } from "./channels";

interface LiveEntry {
  kind: SessionMode;
  pty?: PtyHandle;
  rpc?: RpcClient;
  record: OwnedSessionRecord;
  /** Suppresses this process's pty:exit — set for a mode-switch kill and for a delete. */
  suppressExit?: boolean;
  /** Resolves once the child's exit has been observed. */
  readonly exited: Promise<void>;
  /** Resolver for `exited`, called from the exit handler. */
  readonly markExited: () => void;
}

function liveEntry(fields: Omit<LiveEntry, "exited" | "markExited">): LiveEntry {
  let markExited = (): void => {};
  const exited = new Promise<void>((resolve) => {
    markExited = () => resolve();
  });
  return { ...fields, exited, markExited };
}

/** True when `p` settles inside `ms`. Bounded wait, no dangling timer. */
function settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** How long omp gets to exit on its own before the delete escalates. */
const GRACEFUL_EXIT_MS = 3_000;
const SIGKILL_EXIT_MS = 2_000;

/** The only owner of live session state; the renderer mirrors via broadcasts. */
export class MainBackend {
  private readonly live = new Map<string, LiveEntry>();
  private readonly registry: Registry;
  private ompPath = resolveOmpBinary();
  private readonly watchers = new Map<string, () => void>();
  /**
   * In-flight resume spawns, keyed by tab — registered before the first await
   * (double-click race). The value settles when the spawn does, so a delete
   * arriving mid-spawn can wait for the process to exist and then kill it.
   */
  private readonly spawning = new Map<string, Promise<void>>();
  private readonly appUpdater: AppUpdater;
  private readonly ompUpdater: OmpUpdater;

  constructor(
    private readonly win: BrowserWindow,
    registryFile: string,
    opts: {
      confirmQuit?: () => Promise<boolean>;
      appUpdateEnabled?: boolean;
      appVersion?: string;
      appUpdateEnv?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.registry = Registry.load(registryFile);
    this.appUpdater = new AppUpdater({
      win,
      enabled: opts.appUpdateEnabled ?? app.isPackaged,
      currentVersion: opts.appVersion ?? app.getVersion(),
      env: opts.appUpdateEnv,
      downloadsDir: app.getPath("downloads"),
      getDismissed: () => this.registry.dismissedAppUpdateVersion,
      setDismissed: (v) => this.registry.setDismissedAppUpdateVersion(v),
      confirmQuit: opts.confirmQuit ?? (async () => true),
      send: (ch, s) => this.send(ch, s),
      channel: CH.appUpdateState,
    });
    this.ompUpdater = new OmpUpdater({
      getDismissed: () => this.registry.dismissedOmpUpdateVersion,
      setDismissed: (v) => this.registry.setDismissedOmpUpdateVersion(v),
      onApplied: () => this.refreshOmpPath(),
      send: (ch, s) => this.send(ch, s),
      channel: CH.ompUpdateState,
    });
  }

  get liveCount(): number {
    return this.live.size;
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

  /** On/after quit the webContents is gone — late events must not throw. */
  private send(channel: string, ...args: unknown[]): void {
    if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    this.win.webContents.send(channel, ...args);
  }

  registerIpc(): void {
    ipcMain.handle(CH.stateGet, () => this.buildState());
    ipcMain.handle(CH.projectAdd, async (_e, raw: string) => {
      const resolved = await resolveProjectPath(raw);
      const record = this.registry.addProject(resolved);
      await this.broadcast();
      return record;
    });
    ipcMain.handle(CH.dirBrowse, (_e, partialPath: string) => browseDirectories(partialPath));
    ipcMain.handle(CH.projectRemove, async (_e, projectPath: string) => {
      for (const entry of this.live.values()) {
        if (entry.record.projectCwd === projectPath) {
          throw new Error("project has live sessions — terminate them first");
        }
      }
      for (const s of this.registry.sessions.filter((s) => s.projectCwd === projectPath)) {
        this.stopWatcher(s.tabId);
      }
      this.registry.removeProject(projectPath);
      await this.broadcast();
    });
    ipcMain.handle(CH.settingsSetDefaultMode, async (_e, mode: SessionMode) => {
      this.registry.setDefaultMode(mode);
      await this.broadcast();
    });
    ipcMain.handle(CH.settingsSetSkipDeleteConfirmation, async (_e, skip: boolean) => {
      this.registry.setSkipDeleteConfirmation(skip);
      await this.broadcast();
    });
    ipcMain.handle(CH.favoritesToggle, async (_e, key: string) => {
      this.registry.toggleFavorite(key);
      await this.broadcast();
    });
    ipcMain.handle(
      CH.sessionSetModel,
      (_e, tabId: string, model: string | null, thinkingLevel: string | null) => {
        this.registry.setSessionModel(tabId, model, thinkingLevel);
        void this.broadcast();
      },
    );
    ipcMain.handle(CH.sessionSpawn, (_e, req: SpawnRequest) => this.spawn(req));
    ipcMain.handle(CH.sessionTerminate, (_e, tabId: string) => this.terminate(tabId));
    ipcMain.handle(CH.sessionSwitchMode, (_e, tabId: string, mode: SessionMode) =>
      this.switchMode(tabId, mode),
    );
    ipcMain.handle(CH.sessionDelete, (_e, tabId: string) => this.deleteSession(tabId));
    ipcMain.handle(
      CH.sessionSetAdvisor,
      (_e, tabId: string, advisor: boolean, advisorModel: string | null) =>
        this.setSessionAdvisor(tabId, advisor, advisorModel),
    );
    ipcMain.handle(
      CH.advisorDefaults,
      (_e, projectCwd: string): AdvisorDefaults => this.advisorDefaults(projectCwd),
    );
    ipcMain.handle(CH.titleGenerate, (_e, projectCwd: string, prompt: string) =>
      this.generateTitle(projectCwd, prompt),
    );
    ipcMain.handle(CH.planRead, (_e, tabId: string, absPath: string) =>
      this.readPlanFile(tabId, absPath),
    );
    ipcMain.handle(CH.branchDiff, (_e, projectCwd: string) => readBranchDiff(projectCwd));
    // Stateless core calls: a checkout touches no registry/BackendState field,
    // so these handlers never broadcast().
    ipcMain.handle(CH.branchList, (_e, projectCwd: string) => listBranches(projectCwd));
    ipcMain.handle(
      CH.branchCheckout,
      (_e, projectCwd: string, name: string, opts?: { create?: boolean }) =>
        checkoutBranch(projectCwd, name, opts),
    );
    ipcMain.handle(CH.mcpList, (_e, projectCwd: string) => resolveMcpServers(projectCwd));
    ipcMain.handle(CH.mcpSetEnabled, (_e, req: McpSetEnabledRequest) => setMcpServerEnabled(req));
    ipcMain.handle(CH.sessionRestart, (_e, tabId: string) => this.restartSession(tabId));
    ipcMain.handle(CH.projectFilesList, (_e, projectCwd: string) => listProjectFiles(projectCwd));
    ipcMain.handle(CH.fileMentionsResolve, (_e, projectCwd: string, message: string) =>
      resolveFileMentions(projectCwd, message),
    );
    ipcMain.handle(CH.ptyPasteImage, (_e, tabId: string, image: ImageAttachment) =>
      this.ptyPasteImage(tabId, image),
    );
    ipcMain.on(CH.ptyWrite, (_e, tabId: string, data: string) => {
      this.live.get(tabId)?.pty?.write(data);
    });
    ipcMain.on(CH.ptyResize, (_e, tabId: string, cols: number, rows: number) => {
      this.live.get(tabId)?.pty?.resize(cols, rows);
    });
    ipcMain.on(CH.rpcSend, (_e, tabId: string, cmd: object) => {
      this.live.get(tabId)?.rpc?.send(cmd);
    });
    ipcMain.handle(CH.ompUpdateGetState, () => this.ompUpdater.state);
    ipcMain.handle(CH.ompUpdateCheck, () => this.ompUpdater.checkNow(true));
    ipcMain.handle(CH.ompUpdateDownload, () => this.ompUpdater.download());
    ipcMain.handle(CH.ompUpdateDismiss, (_e, version: string, remember: boolean) =>
      this.ompUpdater.dismiss(version, remember),
    );
    ipcMain.handle(CH.appUpdateGetState, () => this.appUpdater.state);
    ipcMain.handle(CH.appUpdateCheck, () => this.appUpdater.checkNow(true));
    ipcMain.handle(CH.appUpdateDownload, () => this.appUpdater.download());
    ipcMain.handle(CH.appUpdateOpenNotes, () => this.appUpdater.openReleaseNotes());
    ipcMain.handle(CH.appUpdateShowDownload, () => this.appUpdater.showDownload());
    ipcMain.handle(CH.appUpdateRestart, () => this.appUpdater.restart());
    ipcMain.handle(CH.appUpdateDismiss, (_e, version: string, remember: boolean) =>
      this.appUpdater.dismiss(version, remember),
    );
  }

  /** Launch-time background check — quiet unless an update is available. */
  checkAppUpdateBackground(): void {
    void this.appUpdater.checkNow(false);
  }

  /** Launch-time background check — quiet unless an install/update offer exists. */
  checkOmpUpdateBackground(): void {
    void this.ompUpdater.checkNow(false);
  }

  async hydrateAll(): Promise<void> {
    for (const record of this.registry.sessions) this.startWatcher(record);
    await this.broadcast();
  }

  killAll(): void {
    for (const entry of this.live.values()) {
      entry.pty?.kill();
      entry.rpc?.kill();
    }
    this.live.clear();
  }

  async spawn(req: SpawnRequest): Promise<{ tabId: string }> {
    // Dedupe guard — the renderer should never send this, but a second
    // process for the same session would corrupt the .jsonl. The in-flight
    // set closes the race window before the first await (live.set happens
    // after async prepareResume).
    let spawnSettled = (): void => {};
    if (req.resumeTabId) {
      if (this.live.has(req.resumeTabId) || this.spawning.has(req.resumeTabId)) {
        return { tabId: req.resumeTabId };
      }
      this.spawning.set(
        req.resumeTabId,
        new Promise<void>((resolve) => {
          spawnSettled = () => resolve();
        }),
      );
    }
    try {
      if (!this.ompPath) {
        throw new Error(
          "omp binary not found (looked in $OMP_UI_OMP_PATH, PATH, ~/.bun/bin, /usr/local/bin, ~/.local/bin)",
        );
      }

      let record: OwnedSessionRecord;
      if (req.resumeTabId) {
        const existing = this.registry.sessions.find((s) => s.tabId === req.resumeTabId);
        if (!existing) throw new Error(`unknown session tab ${req.resumeTabId}`);
        record = await this.prepareResume(existing);
      } else {
        const project = this.registry.projects.find((p) => p.path === req.projectCwd);
        record = this.registry.addSession({
          tabId: randomUUID(),
          sessionId: null,
          lineageDir: mintLineageDirName(req.projectCwd),
          projectCwd: req.projectCwd,
          launchedAt: new Date().toISOString(),
          mode: req.mode,
          model: project?.lastModel ?? null,
          thinkingLevel: project?.lastThinkingLevel ?? null,
          advisor: req.advisor,
          advisorModel: req.advisorModel ?? null,
          cachedTitle: null,
          cachedModified: null,
        });
        // The launched values are now the project's last session parameters,
        // even when they originated in omp config rather than an explicit click.
        this.registry.setSessionAdvisor(record.tabId, record.advisor, record.advisorModel);
      }
      const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
      if (record.mode !== req.mode) patch.mode = req.mode;
      // A resume carries the caller's advisor intent; `undefined` means "keep
      // whatever the record already says" so a plain reopen is not a reset.
      if (req.advisorModel !== undefined && req.advisorModel !== record.advisorModel) {
        patch.advisorModel = req.advisorModel;
      }
      if (req.advisor !== record.advisor && req.resumeTabId) patch.advisor = req.advisor;
      if (Object.keys(patch).length > 0) {
        record = this.registry.updateSession(record.tabId, patch) ?? record;
      }

      return req.mode === "rpc-ui" ? this.spawnRpc(record) : await this.spawnPty(record, req);
    } finally {
      if (req.resumeTabId) {
        this.spawning.delete(req.resumeTabId);
        spawnSettled();
      }
    }
  }

  private async spawnPty(
    record: OwnedSessionRecord,
    req: SpawnRequest,
  ): Promise<{ tabId: string }> {
    const absLineageDir = path.join(this.sessionsRoot, record.lineageDir);
    const ptyHandle = spawnOmp({
      id: record.tabId,
      cwd: record.projectCwd,
      lineageDir: absLineageDir,
      ompPath: this.ompPath!,
      resumeSessionId: record.sessionId ?? undefined,
      cols: req.cols,
      rows: req.rows,
      advisor: record.advisor,
      configOverlays: this.configOverlays(record, absLineageDir),
    });
    const entry = liveEntry({ kind: "pty", pty: ptyHandle, record });
    this.live.set(record.tabId, entry);
    ptyHandle.onData((data) => this.send(CH.ptyData, record.tabId, data));
    ptyHandle.onExit(({ exitCode }) => {
      entry.markExited();
      // Identity-checked: a mode-switch respawn may already have replaced
      // this entry — deleting then would orphan the new live session.
      if (this.live.get(record.tabId) === entry) this.live.delete(record.tabId);
      if (!entry.suppressExit) this.send(CH.ptyExit, record.tabId, exitCode);
      void this.broadcast();
    });
    this.startWatcher(record);
    await this.broadcast();
    return { tabId: record.tabId };
  }

  private spawnRpc(record: OwnedSessionRecord): { tabId: string } {
    const absLineageDir = path.join(this.sessionsRoot, record.lineageDir);
    // Exactly like PTY (ADR-0003) — and the dir must exist for the watcher.
    fs.mkdirSync(absLineageDir, { recursive: true });
    const entry = liveEntry({ kind: "rpc-ui", record });
    entry.rpc = new RpcClient({
      cwd: record.projectCwd,
      lineageDir: absLineageDir,
      ompPath: this.ompPath!,
      resumeSessionId: record.sessionId ?? undefined,
      advisor: record.advisor,
      configOverlays: this.configOverlays(record, absLineageDir),
      extensions: this.planExtensions(absLineageDir),
      onFrame: (frame) => this.send(CH.rpcFrame, record.tabId, frame),
      onExit: (code) => {
        entry.markExited();
        if (this.live.get(record.tabId) === entry) this.live.delete(record.tabId);
        if (!entry.suppressExit) this.send(CH.ptyExit, record.tabId, code ?? -1);
        void this.broadcast();
      },
      onError: (msg) => this.send(CH.rpcFrame, record.tabId, { type: "omp_ui_error", message: msg }),
    });
    this.live.set(record.tabId, entry);
    this.startWatcher(record);
    void this.broadcast();
    return { tabId: record.tabId };
  }

  /** Rewrites spawn overlays from the session record on every launch. */
  private configOverlays(record: OwnedSessionRecord, absLineageDir: string): string[] {
    const overlays: string[] = [];
    const advisorRole = record.advisorModel === null ? null : parseModelRole(record.advisorModel);
    try {
      const overlay = writeAdvisorOverlay(absLineageDir, advisorRole, record.advisor);
      if (overlay !== null) overlays.push(overlay);
    } catch (err) {
      console.warn("[advisor] could not write the overlay:", err);
    }
    const model = record.model ?? null;
    if (model !== null) {
      const selector =
        record.thinkingLevel == null ? model : `${model}:${record.thinkingLevel}`;
      try {
        const overlay = writeDefaultModelOverlay(absLineageDir, parseModelRole(selector));
        if (overlay !== null) overlays.push(overlay);
      } catch (err) {
        console.warn("[model] could not write the default-model overlay:", err);
      }
    }
    return overlays;
  }

  /**
   * The `-e` extensions an rpc-ui spawn needs (plan mode, advisor stats). Both
   * are rewritten on every spawn so a stale copy from an older omp-ui build can
   * never outvote the current wire contract. A failed write degrades to a
   * session without that feature — omp rejects a missing `-e` path at startup,
   * so shipping the arg anyway would take the whole session down.
   */
  private planExtensions(absLineageDir: string): string[] {
    const extensions: string[] = [];
    try {
      extensions.push(writePlanExtension(absLineageDir));
    } catch (err) {
      console.warn("[plan] could not write the plan extension:", err);
    }
    try {
      extensions.push(writeAdvisorStatsExtension(absLineageDir));
    } catch (err) {
      console.warn("[advisor] could not write the advisor-stats extension:", err);
    }
    return extensions;
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
   * Re-pins a session's advisor. omp resolves both `advisor.enabled` and the
   * `advisor` role at process start and never re-reads them, so a live session
   * has to be relaunched — the same kill-and-`--resume` dance as a mode switch,
   * and for the same reason: sessions are durable, so this loses nothing.
   */
  private async setSessionAdvisor(
    tabId: string,
    advisor: boolean,
    advisorModel: string | null,
  ): Promise<void> {
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const changed = record.advisor !== advisor || record.advisorModel !== advisorModel;
    this.registry.setSessionAdvisor(tabId, advisor, advisorModel);
    if (!changed) {
      await this.broadcast();
      return;
    }
    const entry = this.live.get(tabId);
    if (!entry) {
      // Dormant: the next launch picks the new values up from the record.
      await this.broadcast();
      return;
    }
    await this.relaunch(entry, {
      projectCwd: record.projectCwd,
      mode: record.mode,
      advisor,
      advisorModel,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
  }

  /**
   * Restarts a live session in place so it picks up config omp resolves at
   * process start (the MCP manager's toggles). The same kill-and-`--resume`
   * dance as the advisor/mode-switch relaunch — sessions are durable, so this
   * loses nothing. Rejects when the session is not live: a dormant session
   * already picks the new config up on its next launch, so there is nothing
   * to restart.
   */
  private async restartSession(tabId: string): Promise<void> {
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    const entry = this.live.get(tabId);
    if (!record || !entry) throw new Error("session is not live");
    await this.relaunch(entry, {
      projectCwd: record.projectCwd,
      mode: record.mode,
      advisor: record.advisor,
      advisorModel: record.advisorModel,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
  }

  /**
   * Delivers a pasted image to a PTY session. The PTY carries no byte channel,
   * so the bytes go to a scratch file and omp's TUI editor is handed the path
   * as a bracketed paste — it loads the file and attaches a real image block.
   */
  private async ptyPasteImage(tabId: string, image: ImageAttachment): Promise<void> {
    const pty = this.live.get(tabId)?.pty;
    if (!pty) throw new Error("session is not running in terminal mode");
    if (base64Bytes(image.data) > MAX_IMAGE_BYTES) {
      throw new Error(`image is over omp's ${MAX_IMAGE_BYTES / (1024 * 1024)} MB input limit`);
    }
    const file = writeImageToScratch(image);
    pty.write(bracketedImagePaste(file));
    // The scratch file outlives this call on purpose: omp reads it after the
    // paste is delivered, and it also backs the transcript's image blob.
    await Promise.resolve();
  }

  /** Unarchives / adopts as needed so spawn can --resume the right session. */
  private async prepareResume(record: OwnedSessionRecord): Promise<OwnedSessionRecord> {
    const loc = await resolveSessionLocation(
      this.sessionsRoot,
      this.archiveRoot,
      record.lineageDir,
      record.sessionId,
    );
    if (loc.where === "missing") {
      // omp writes the transcript lazily, on the first turn, so a session
      // relaunched before it has said anything has no file yet — and a record
      // that never had a `sessionId` never had one to lose. That is a fresh
      // start, not a loss: spawn proceeds with no `--resume` and omp opens the
      // session it was always going to. Only a record that *did* name a
      // session and can no longer find it has actually lost something.
      if (record.sessionId === null) return record;
      throw new Error("session files are gone — delete it from the sidebar");
    }
    if (loc.where === "archived") {
      let sessionId = record.sessionId;
      if (!sessionId) {
        // Adopt the id from the archived file name (<timestamp>_<id>.jsonl.gz).
        const m = /_([^_]+)\.jsonl\.gz$/.exec(loc.filePath);
        if (!m) throw new Error(`cannot identify archived session file ${loc.filePath}`);
        sessionId = m[1]!;
      }
      await unarchiveSession(this.sessionsRoot, this.archiveRoot, record.lineageDir, sessionId);
      if (sessionId !== record.sessionId) {
        record = this.registry.updateSession(record.tabId, { sessionId }) ?? record;
      }
      return record;
    }
    // Active: adopt the file's header id when it differs (stale or null id).
    try {
      const h = await hydrateSessionFile(loc.filePath);
      if (h.id && h.id !== record.sessionId) {
        record =
          this.registry.updateSession(record.tabId, {
            sessionId: h.id,
            cachedTitle: h.title ?? record.cachedTitle,
            cachedModified: h.mtime.toISOString(),
          }) ?? record;
      }
    } catch {
      // Head unreadable — spawn proceeds without --resume.
    }
    return record;
  }

  terminate(tabId: string): void {
    const entry = this.live.get(tabId);
    if (!entry) return;
    entry.pty?.kill();
    entry.rpc?.kill();
    // The record stays; the broadcast fires on process exit.
  }

  /**
   * Erases a session's record and its files. A live session is stopped first
   * rather than refused: the user asked for the session to be gone, and making
   * them terminate it by hand is a step with no decision in it.
   *
   * The process must actually be reaped before the files go — omp writes its
   * transcript on the way out, and unlinking the lineage dir under a live
   * writer would recreate it (or lose the delete). `spawning` matters as much
   * as `live`: prepareResume awaits before live.set, so a delete landing in
   * that window has to wait for the spawn to finish before it can kill it.
   */
  async deleteSession(tabId: string): Promise<void> {
    const inFlight = this.spawning.get(tabId);
    if (inFlight) await inFlight;
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const entry = this.live.get(tabId);
    if (entry) await this.killAndReap(tabId, entry);
    this.stopWatcher(tabId);
    // Files first: a failed delete must leave the record so the row stays
    // visible and retryable, rather than orphaning the transcript on disk.
    try {
      await deleteSessionFiles(this.sessionsRoot, this.archiveRoot, record.lineageDir);
    } catch (err) {
      this.startWatcher(record);
      throw err;
    }
    this.registry.removeSession(tabId);
    await this.broadcast();
  }

  /**
   * Stops a live session and waits for the child to be reaped, escalating to
   * SIGKILL if omp does not honour the default signal. Throws when even that
   * fails — the caller must not unlink files out from under a live writer.
   *
   * The exit is suppressed: the tab is about to disappear, so a "session
   * exited" notice would be noise about a session the user just deleted.
   */
  private async killAndReap(tabId: string, entry: LiveEntry): Promise<void> {
    entry.suppressExit = true;
    entry.pty?.kill();
    entry.rpc?.kill();
    if (await settledWithin(entry.exited, GRACEFUL_EXIT_MS)) return;
    entry.pty?.kill("SIGKILL");
    entry.rpc?.kill("SIGKILL");
    if (await settledWithin(entry.exited, SIGKILL_EXIT_MS)) return;
    // Un-suppress: the process outlived us, so the tab is still live and the
    // renderer must keep showing it that way.
    entry.suppressExit = false;
    throw new Error(`session ${tabId} did not exit — its files were left alone`);
  }

  async switchMode(tabId: string, mode: SessionMode): Promise<void> {
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (!record || record.mode === mode) return;
    const entry = this.live.get(tabId);
    if (!entry) {
      this.registry.updateSession(tabId, { mode });
      await this.broadcast();
      return;
    }
    // Live: kill + relaunch in the new mode with --resume (sessions are
    // durable — this is a relaunch, not a loss).
    await this.relaunch(entry, {
      projectCwd: record.projectCwd,
      mode,
      advisor: record.advisor,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
  }

  /**
   * Kills a live session and spawns it again with `--resume`. The one way to
   * change anything omp binds at process start (its mode, its advisor).
   *
   * `suppressExit` hides the old process's exit so the renderer does not
   * flash a dead tab mid-swap — which means a failed respawn would otherwise
   * be silent, leaving the tab looking live over a corpse. So the notice is
   * re-sent by hand on that path, and only that path.
   */
  private async relaunch(entry: LiveEntry, req: SpawnRequest): Promise<void> {
    const tabId = req.resumeTabId!;
    entry.suppressExit = true;
    entry.pty?.kill();
    entry.rpc?.kill();
    this.live.delete(tabId);
    try {
      await this.spawn(req);
    } catch (err) {
      // -1 is the same code spawnRpc's own exit path uses for "no status".
      this.send(CH.ptyExit, tabId, -1);
      await this.broadcast();
      throw err;
    }
  }

  private startWatcher(record: OwnedSessionRecord): void {
    this.stopWatcher(record.tabId);
    const absDir = path.join(this.sessionsRoot, record.lineageDir);
    if (!fs.existsSync(absDir)) return; // archived/missing — rewatched on respawn
    this.watchers.set(
      record.tabId,
      watchLineageDir(absDir, (e) => {
        if (e.kind === "vanished") {
          this.watchers.delete(record.tabId);
          void this.broadcast();
          return;
        }
        void this.onSessionFile(record.tabId, e.filePath);
      }),
    );
  }

  private stopWatcher(tabId: string): void {
    this.watchers.get(tabId)?.();
    this.watchers.delete(tabId);
  }

  /** First materialization, /new, /branch, title-slot rewrites → adopt + broadcast. */
  private async onSessionFile(tabId: string, filePath: string): Promise<void> {
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    try {
      const h = await hydrateSessionFile(filePath);
      const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
      if (h.id && h.id !== record.sessionId) patch.sessionId = h.id;
      // The padded title slot can yield "" — treat blank as no title.
      const title = h.title?.trim() ? h.title : null;
      if (title !== record.cachedTitle) patch.cachedTitle = title;
      const modified = h.mtime.toISOString();
      if (modified !== record.cachedModified) patch.cachedModified = modified;
      if (Object.keys(patch).length > 0) {
        this.registry.updateSession(tabId, patch);
        await this.broadcast();
      }
    } catch {
      // Mid-write or vanished — the next event (or state rebuild) retries.
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
    groups.sort((a, b) => a.project.addedAt.localeCompare(b.project.addedAt));
    return {
      projects: groups,
      defaultMode: this.registry.defaultMode,
      modelFavorites: this.registry.getFavorites(),
      skipDeleteConfirmation: this.registry.skipDeleteConfirmation,
    };
  }

  private async summarize(record: OwnedSessionRecord): Promise<SessionSummary> {
    const loc = await resolveSessionLocation(
      this.sessionsRoot,
      this.archiveRoot,
      record.lineageDir,
      record.sessionId,
    );
    const live: LiveState = this.live.has(record.tabId)
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
    return { ...record, title: title?.trim() || "New session", status, live };
  }

  private async broadcast(): Promise<void> {
    if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    const state = await this.buildState();
    this.send(CH.stateChanged, state);
  }
}
