import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dialog, ipcMain, type BrowserWindow } from "electron";
import {
  deleteSessionFiles,
  getArchiveRoot,
  getSessionsRoot,
  hydrateSessionFile,
  mintLineageDirName,
  Registry,
  resolveOmpBinary,
  resolveSessionLocation,
  RpcClient,
  spawnOmp,
  unarchiveSession,
  watchLineageDir,
  type BackendState,
  type LiveState,
  type OwnedSessionRecord,
  type ProjectGroup,
  type PtyHandle,
  type SessionMode,
  type SessionSummary,
  type SpawnRequest,
} from "@omp-ui/core";
import { CH } from "./channels";

interface LiveEntry {
  kind: SessionMode;
  pty?: PtyHandle;
  rpc?: RpcClient;
  record: OwnedSessionRecord;
  /** Set during a mode-switch kill so no pty:exit reaches the renderer. */
  restarting?: boolean;
}

/** The only owner of live session state; the renderer mirrors via broadcasts. */
export class MainBackend {
  private readonly live = new Map<string, LiveEntry>();
  private readonly registry: Registry;
  private readonly ompPath = resolveOmpBinary();
  private readonly watchers = new Map<string, () => void>();
  /** In-flight resume spawns — closed before the first await (double-click race). */
  private readonly spawning = new Set<string>();

  constructor(
    private readonly win: BrowserWindow,
    registryFile: string,
  ) {
    this.registry = Registry.load(registryFile);
  }

  get liveCount(): number {
    return this.live.size;
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
    ipcMain.handle(CH.projectAdd, async () => {
      const r = await dialog.showOpenDialog(this.win, {
        properties: ["openDirectory", "createDirectory"],
      });
      if (r.canceled || r.filePaths.length === 0) return null;
      const record = this.registry.addProject(r.filePaths[0]!);
      await this.broadcast();
      return record;
    });
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
    ipcMain.handle(CH.projectSetAdvisor, async (_e, projectPath: string, advisor: boolean) => {
      this.registry.setProjectAdvisor(projectPath, advisor);
      await this.broadcast();
    });
    ipcMain.handle(CH.settingsSetDefaultMode, async (_e, mode: SessionMode) => {
      this.registry.setDefaultMode(mode);
      await this.broadcast();
    });
    ipcMain.handle(CH.sessionSpawn, (_e, req: SpawnRequest) => this.spawn(req));
    ipcMain.handle(CH.sessionTerminate, (_e, tabId: string) => this.terminate(tabId));
    ipcMain.handle(CH.sessionSwitchMode, (_e, tabId: string, mode: SessionMode) =>
      this.switchMode(tabId, mode),
    );
    ipcMain.handle(CH.sessionDelete, async (_e, tabId: string) => {
      if (this.live.has(tabId)) throw new Error("session is live — terminate it first");
      const record = this.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) return;
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
    });
    ipcMain.on(CH.ptyWrite, (_e, tabId: string, data: string) => {
      this.live.get(tabId)?.pty?.write(data);
    });
    ipcMain.on(CH.ptyResize, (_e, tabId: string, cols: number, rows: number) => {
      this.live.get(tabId)?.pty?.resize(cols, rows);
    });
    ipcMain.on(CH.rpcSend, (_e, tabId: string, cmd: object) => {
      this.live.get(tabId)?.rpc?.send(cmd);
    });
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
    if (req.resumeTabId) {
      if (this.live.has(req.resumeTabId) || this.spawning.has(req.resumeTabId)) {
        return { tabId: req.resumeTabId };
      }
      this.spawning.add(req.resumeTabId);
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
        record = this.registry.addSession({
          tabId: randomUUID(),
          sessionId: null,
          lineageDir: mintLineageDirName(req.projectCwd),
          projectCwd: req.projectCwd,
          launchedAt: new Date().toISOString(),
          mode: req.mode,
          advisor: req.advisor,
          cachedTitle: null,
          cachedModified: null,
        });
      }
      if (record.mode !== req.mode) {
        record = this.registry.updateSession(record.tabId, { mode: req.mode }) ?? record;
      }

      return req.mode === "rpc-ui" ? this.spawnRpc(record) : await this.spawnPty(record, req);
    } finally {
      if (req.resumeTabId) this.spawning.delete(req.resumeTabId);
    }
  }

  private async spawnPty(
    record: OwnedSessionRecord,
    req: SpawnRequest,
  ): Promise<{ tabId: string }> {
    const ptyHandle = spawnOmp({
      id: record.tabId,
      cwd: record.projectCwd,
      lineageDir: path.join(this.sessionsRoot, record.lineageDir),
      ompPath: this.ompPath!,
      resumeSessionId: record.sessionId ?? undefined,
      cols: req.cols,
      rows: req.rows,
      advisor: record.advisor,
    });
    const entry: LiveEntry = { kind: "pty", pty: ptyHandle, record };
    this.live.set(record.tabId, entry);
    ptyHandle.onData((data) => this.send(CH.ptyData, record.tabId, data));
    ptyHandle.onExit(({ exitCode }) => {
      // Identity-checked: a mode-switch respawn may already have replaced
      // this entry — deleting then would orphan the new live session.
      if (this.live.get(record.tabId) === entry) this.live.delete(record.tabId);
      if (!entry.restarting) this.send(CH.ptyExit, record.tabId, exitCode);
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
    const entry: LiveEntry = { kind: "rpc-ui", record };
    entry.rpc = new RpcClient({
      cwd: record.projectCwd,
      lineageDir: absLineageDir,
      ompPath: this.ompPath!,
      resumeSessionId: record.sessionId ?? undefined,
      advisor: record.advisor,
      onFrame: (frame) => this.send(CH.rpcFrame, record.tabId, frame),
      onExit: (code) => {
        if (this.live.get(record.tabId) === entry) this.live.delete(record.tabId);
        if (!entry.restarting) this.send(CH.ptyExit, record.tabId, code ?? -1);
        void this.broadcast();
      },
      onError: (msg) => this.send(CH.rpcFrame, record.tabId, { type: "omp_ui_error", message: msg }),
    });
    this.live.set(record.tabId, entry);
    this.startWatcher(record);
    void this.broadcast();
    return { tabId: record.tabId };
  }

  /** Unarchives / adopts as needed so spawn can --resume the right session. */
  private async prepareResume(record: OwnedSessionRecord): Promise<OwnedSessionRecord> {
    const loc = await resolveSessionLocation(
      this.sessionsRoot,
      this.archiveRoot,
      record.lineageDir,
      record.sessionId,
    );
    if (loc.where === "missing") throw new Error("session files are gone — delete it from the sidebar");
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
    entry.restarting = true;
    entry.pty?.kill();
    entry.rpc?.kill();
    this.live.delete(tabId);
    await this.spawn({
      projectCwd: record.projectCwd,
      mode,
      advisor: record.advisor,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
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
    return { projects: groups, defaultMode: this.registry.defaultMode };
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
