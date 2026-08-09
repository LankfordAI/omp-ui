import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CH,
  base64Bytes,
  bracketedImagePaste,
  deleteSessionFiles,
  forkSessionFile,
  hydrateSessionFile,
  mintLineageDirName,
  parseModelRole,
  planMessage,
  type ProviderKeys,
  type Registry,
  resolveSessionLocation,
  RpcClient,
  spawnOmp,
  spawnShell,
  unarchiveSession,
  watchLineageDir,
  writeAdvisorOverlay,
  writeAdvisorStatsExtension,
  writeDefaultModelOverlay,
  writeImageToScratch,
  writePlanExtension,
  MAX_IMAGE_BYTES,
  type ImageAttachment,
  type OwnedSessionRecord,
  type PtyHandle,
  type SessionMode,
  type SpawnRequest,
} from "@omp-ui/core";

interface LiveEntry {
  kind: SessionMode;
  pty?: PtyHandle;
  rpc?: RpcClient;
  record: OwnedSessionRecord;
  /** Suppresses this process's pty:exit — set for a mode-switch kill and for a delete. */
  suppressExit?: boolean;
  /** Detaches the pty:data listener — a killed process must not write into its successor. */
  detachPtyData?: () => void;
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

export interface SessionManagerDependencies {
  registry: Registry;
  providerKeys: ProviderKeys;
  getOmpPath: () => string | null;
  getSessionsRoot: () => string;
  getArchiveRoot: () => string;
  send: (channel: string, ...args: unknown[]) => void;
  broadcast: () => Promise<void>;
}

/** The sole owner of live session children and their supporting process state. */
export class SessionManager {
  private readonly live = new Map<string, LiveEntry>();
  /** Console-drawer shells keyed by tabId (issue #42) — outside `live` on purpose. */
  private readonly shells = new Map<string, { handle: PtyHandle; detachData: () => void }>();
  private readonly watchers = new Map<string, () => void>();
  /**
   * In-flight resume spawns, keyed by tab — registered before the first await
   * (double-click race). The value settles when the spawn does, so a delete
   * arriving mid-spawn can wait for the process to exist and then kill it.
   */
  private readonly spawning = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionManagerDependencies) {}

  get liveCount(): number {
    return this.live.size;
  }

  isLive(tabId: string): boolean {
    return this.live.has(tabId);
  }

  hasLiveInProject(projectCwd: string): boolean {
    for (const entry of this.live.values()) {
      if (entry.record.projectCwd === projectCwd) return true;
    }
    return false;
  }

  async hydrateAll(): Promise<void> {
    for (const record of this.deps.registry.sessions) this.startWatcher(record);
    await this.deps.broadcast();
  }

  stopProjectWatchers(projectCwd: string): void {
    for (const record of this.deps.registry.sessions) {
      if (record.projectCwd === projectCwd) this.stopWatcher(record.tabId);
    }
  }

  /** Kills every owned child and closes every lineage watcher. */
  killAll(): void {
    for (const entry of this.live.values()) this.killLive(entry);
    this.live.clear();
    for (const tabId of [...this.shells.keys()]) this.killShell(tabId);
    // Lineage watchers hold inotify fds; quit is the one path that must not
    // leave them to the OS — a cancelled quit keeps the app alive without them.
    for (const dispose of this.watchers.values()) dispose();
    this.watchers.clear();
  }

  /**
   * Kills a live session's child and detaches its data listener first, so a
   * dying process's final output cannot land in a successor's renderer state.
   */
  private killLive(entry: LiveEntry): void {
    entry.detachPtyData?.();
    entry.detachPtyData = undefined;
    entry.pty?.kill();
    entry.rpc?.kill();
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
      const ompPath = this.deps.getOmpPath();
      if (!ompPath) {
        throw new Error(
          "omp binary not found (looked in $OMP_UI_OMP_PATH, PATH, ~/.bun/bin, /usr/local/bin, ~/.local/bin)",
        );
      }

      // A new session cannot run without a model credential — omp would crash
      // moments after spawn with no explanation. Resuming an existing session
      // is allowed through (its process may already be keyless but viewable).
      if (!req.resumeTabId && !this.deps.providerKeys.hasModelProvider(req.projectCwd)) {
        throw new Error(
          "No model provider is configured. Add an API key under Settings → Providers before starting a session.",
        );
      }

      let record: OwnedSessionRecord;
      if (req.resumeTabId) {
        const existing = this.deps.registry.sessions.find((s) => s.tabId === req.resumeTabId);
        if (!existing) throw new Error(`unknown session tab ${req.resumeTabId}`);
        record = await this.prepareResume(existing);
      } else {
        const project = this.deps.registry.projects.find((p) => p.path === req.projectCwd);
        record = this.deps.registry.addSession({
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
        this.deps.registry.setSessionAdvisor(record.tabId, record.advisor, record.advisorModel);
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
        record = this.deps.registry.updateSession(record.tabId, patch) ?? record;
      }

      return req.mode === "rpc-ui"
        ? this.spawnRpc(record, req.resumeTabId === undefined, ompPath)
        : await this.spawnPty(record, req, ompPath);
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
    ompPath: string,
  ): Promise<{ tabId: string }> {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    const ptyHandle = spawnOmp({
      id: record.tabId,
      cwd: record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      cols: req.cols,
      rows: req.rows,
      advisor: record.advisor,
      configOverlays: this.configOverlays(record, absLineageDir),
    });
    const entry = liveEntry({ kind: "pty", pty: ptyHandle, record });
    this.live.set(record.tabId, entry);
    entry.detachPtyData = ptyHandle.onData((data) =>
      this.deps.send(CH.onPtyData, record.tabId, data),
    );
    ptyHandle.onExit(({ exitCode }) => {
      entry.markExited();
      // Identity-checked: a mode-switch respawn may already have replaced
      // this entry — deleting then would orphan the new live session.
      if (this.live.get(record.tabId) === entry) this.live.delete(record.tabId);
      if (!entry.suppressExit) this.deps.send(CH.onPtyExit, record.tabId, exitCode);
      void this.deps.broadcast();
    });
    this.startWatcher(record);
    await this.deps.broadcast();
    return { tabId: record.tabId };
  }

  private spawnRpc(
    record: OwnedSessionRecord,
    startInPlanMode: boolean,
    ompPath: string,
  ): { tabId: string } {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    // Exactly like PTY (ADR-0003) — and the dir must exist for the watcher.
    fs.mkdirSync(absLineageDir, { recursive: true });
    const entry = liveEntry({ kind: "rpc-ui", record });
    entry.rpc = new RpcClient({
      cwd: record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      advisor: record.advisor,
      configOverlays: this.configOverlays(record, absLineageDir),
      extensions: this.planExtensions(absLineageDir),
      initialCommands:
        startInPlanMode && this.deps.registry.defaultAgentMode === "plan"
          ? [
              {
                type: "prompt",
                id: `omp-ui-initial-plan-${randomUUID()}`,
                message: planMessage(true, this.deps.registry.planFormat),
              },
            ]
          : undefined,
      onFrame: (frame) => this.deps.send(CH.onRpcFrame, record.tabId, frame),
      onExit: (code) => {
        entry.markExited();
        if (this.live.get(record.tabId) === entry) this.live.delete(record.tabId);
        if (!entry.suppressExit) this.deps.send(CH.onPtyExit, record.tabId, code ?? -1);
        void this.deps.broadcast();
      },
      onError: (msg) =>
        this.deps.send(CH.onRpcFrame, record.tabId, { type: "omp_ui_error", message: msg }),
    });
    this.live.set(record.tabId, entry);
    this.startWatcher(record);
    void this.deps.broadcast();
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

  /** The `-e` extensions an rpc-ui spawn needs (plan mode, advisor stats). */
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

  /** Re-pins a session's advisor, relaunching a live child to apply it. */
  async setSessionAdvisor(
    tabId: string,
    advisor: boolean,
    advisorModel: string | null,
  ): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const changed = record.advisor !== advisor || record.advisorModel !== advisorModel;
    this.deps.registry.setSessionAdvisor(tabId, advisor, advisorModel);
    if (!changed) {
      await this.deps.broadcast();
      return;
    }
    const entry = this.live.get(tabId);
    if (!entry) {
      // Dormant: the next launch picks the new values up from the record.
      await this.deps.broadcast();
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

  /** Restarts a live session in place so it picks up process-start config. */
  async restart(tabId: string): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
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

  /** Delivers a pasted image to a PTY session as a scratch-file path. */
  async ptyPasteImage(tabId: string, image: ImageAttachment): Promise<void> {
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

  /** Launches the console drawer's shell terminal in a session project. */
  launchShell(tabId: string, cwd: string, cols: number, rows: number): void {
    this.killShell(tabId);
    const handle = spawnShell({ id: tabId, cwd, cols, rows });
    const detachData = handle.onData((data) => this.deps.send(CH.onShellData, tabId, data));
    this.shells.set(tabId, { handle, detachData });
    handle.onExit(({ exitCode }) => {
      const current = this.shells.get(tabId);
      if (!current || current.handle !== handle) return;
      this.shells.delete(tabId);
      current.detachData();
      this.deps.send(CH.onShellExit, tabId, exitCode);
    });
  }

  shellWrite(tabId: string, data: string): void {
    this.shells.get(tabId)?.handle.write(data);
  }

  shellResize(tabId: string, cols: number, rows: number): void {
    this.shells.get(tabId)?.handle.resize(cols, rows);
  }

  ptyWrite(tabId: string, data: string): void {
    this.live.get(tabId)?.pty?.write(data);
  }

  ptyResize(tabId: string, cols: number, rows: number): void {
    this.live.get(tabId)?.pty?.resize(cols, rows);
  }

  rpcSend(tabId: string, cmd: object): void {
    this.live.get(tabId)?.rpc?.send(cmd);
  }

  killShell(tabId: string): void {
    const shell = this.shells.get(tabId);
    if (!shell) return;
    this.shells.delete(tabId);
    // Detach before kill: the dying shell's final output must not land in the
    // replacement's terminal (respawn) or a closed drawer (kill).
    shell.detachData();
    shell.handle.kill();
  }

  /** Unarchives / adopts as needed so spawn can --resume the right session. */
  private async prepareResume(record: OwnedSessionRecord): Promise<OwnedSessionRecord> {
    const loc = await resolveSessionLocation(
      this.deps.getSessionsRoot(),
      this.deps.getArchiveRoot(),
      record.lineageDir,
      record.sessionId,
    );
    if (loc.where === "missing") {
      // omp writes the transcript lazily, on the first turn. A record that
      // never had a session id is therefore still a fresh start, not a loss.
      if (record.sessionId === null) return record;
      throw new Error("session files are gone — delete it from the sidebar");
    }
    if (loc.where === "archived") {
      let sessionId = record.sessionId;
      if (!sessionId) {
        const m = /_([^_]+)\.jsonl\.gz$/.exec(loc.filePath);
        if (!m) throw new Error(`cannot identify archived session file ${loc.filePath}`);
        sessionId = m[1]!;
      }
      await unarchiveSession(
        this.deps.getSessionsRoot(),
        this.deps.getArchiveRoot(),
        record.lineageDir,
        sessionId,
      );
      if (sessionId !== record.sessionId) {
        record = this.deps.registry.updateSession(record.tabId, { sessionId }) ?? record;
      }
      return record;
    }
    // Active: adopt the file's header id when it differs (stale or null id).
    try {
      const h = await hydrateSessionFile(loc.filePath);
      if (h.id && h.id !== record.sessionId) {
        record =
          this.deps.registry.updateSession(record.tabId, {
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
    this.killShell(tabId);
    const entry = this.live.get(tabId);
    if (!entry) return;
    this.killLive(entry);
    // The record stays; the broadcast fires on process exit.
  }

  /** Erases a session's record and files after its child is fully reaped. */
  async deleteSession(tabId: string): Promise<void> {
    const inFlight = this.spawning.get(tabId);
    if (inFlight) await inFlight;
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const entry = this.live.get(tabId);
    if (entry) await this.killAndReap(tabId, entry);
    this.stopWatcher(tabId);
    this.killShell(tabId);
    // Files first: a failed delete must leave the record so the row stays
    // visible and retryable, rather than orphaning the transcript on disk.
    try {
      await deleteSessionFiles(
        this.deps.getSessionsRoot(),
        this.deps.getArchiveRoot(),
        record.lineageDir,
      );
    } catch (err) {
      this.startWatcher(record);
      throw err;
    }
    this.deps.registry.removeSession(tabId);
    await this.deps.broadcast();
  }

  /** Branches a session by copying its transcript into a fresh lineage. */
  async forkSession(tabId: string): Promise<{ tabId: string }> {
    const source = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!source) throw new Error(`unknown session tab ${tabId}`);
    const loc = await resolveSessionLocation(
      this.deps.getSessionsRoot(),
      this.deps.getArchiveRoot(),
      source.lineageDir,
      source.sessionId,
    );
    if (loc.where !== "active") {
      throw new Error(
        loc.where === "archived"
          ? "unarchive the session before branching it"
          : "this session has no transcript to branch yet",
      );
    }
    const lineageDir = mintLineageDirName(source.projectCwd);
    const sessionId = randomUUID();
    await forkSessionFile(loc.filePath, path.join(this.deps.getSessionsRoot(), lineageDir), sessionId);
    const fork = this.deps.registry.addSession({
      tabId: randomUUID(),
      sessionId,
      lineageDir,
      projectCwd: source.projectCwd,
      launchedAt: new Date().toISOString(),
      mode: source.mode,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
      advisor: source.advisor,
      advisorModel: source.advisorModel,
      cachedTitle: source.cachedTitle,
      cachedModified: new Date().toISOString(),
    });
    await this.deps.broadcast();
    return { tabId: fork.tabId };
  }

  /** Stops a live child and waits for it to be reaped, escalating once. */
  private async killAndReap(tabId: string, entry: LiveEntry): Promise<void> {
    entry.suppressExit = true;
    this.killLive(entry);
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
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record || record.mode === mode) return;
    this.killShell(tabId);
    const entry = this.live.get(tabId);
    if (!entry) {
      this.deps.registry.updateSession(tabId, { mode });
      await this.deps.broadcast();
      return;
    }
    await this.relaunch(entry, {
      projectCwd: record.projectCwd,
      mode,
      advisor: record.advisor,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
  }

  /** Reaps a live session and then spawns it again with `--resume`. */
  private async relaunch(entry: LiveEntry, req: SpawnRequest): Promise<void> {
    const tabId = req.resumeTabId!;
    await this.killAndReap(tabId, entry);
    this.live.delete(tabId);
    try {
      await this.spawn(req);
    } catch (err) {
      // -1 is the same code spawnRpc's own exit path uses for "no status".
      this.deps.send(CH.onPtyExit, tabId, -1);
      await this.deps.broadcast();
      throw err;
    }
  }

  private startWatcher(record: OwnedSessionRecord): void {
    this.stopWatcher(record.tabId);
    const absDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    if (!fs.existsSync(absDir)) return;
    this.watchers.set(
      record.tabId,
      watchLineageDir(absDir, (event) => {
        if (event.kind === "vanished") {
          this.stopWatcher(record.tabId);
          void this.deps.broadcast();
          return;
        }
        void this.onSessionFile(record.tabId, event.filePath);
      }),
    );
  }

  private stopWatcher(tabId: string): void {
    this.watchers.get(tabId)?.();
    this.watchers.delete(tabId);
  }

  /** First materialization, /new, /branch, title-slot rewrites → adopt + broadcast. */
  private async onSessionFile(tabId: string, filePath: string): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    try {
      const h = await hydrateSessionFile(filePath);
      const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
      if (h.id && h.id !== record.sessionId) patch.sessionId = h.id;
      const title = h.title?.trim() ? h.title : null;
      if (title !== record.cachedTitle) patch.cachedTitle = title;
      const modified = h.mtime.toISOString();
      if (modified !== record.cachedModified) patch.cachedModified = modified;
      if (Object.keys(patch).length > 0) {
        this.deps.registry.updateSession(tabId, patch);
        await this.deps.broadcast();
      }
    } catch {
      // Mid-write or vanished — the next event (or state rebuild) retries.
    }
  }
}
