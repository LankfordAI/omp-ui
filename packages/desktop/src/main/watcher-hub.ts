import * as fs from "node:fs";
import * as path from "node:path";
import {
  hydrateSessionFile,
  watchLineageDir,
  type OwnedSessionRecord,
  type Registry,
} from "@omp-ui/core";

/**
 * Min interval between sidebar broadcasts caused purely by session-file mtime
 * churn (issue #187). A mid-turn transcript rewrites its .jsonl constantly;
 * each rewrite used to trigger a full buildState + broadcast, so the renderer
 * re-rendered the whole shell at turn rate on top of the transcript stream.
 */
const WATCHER_BROADCAST_MS = 1_000;

export interface WatcherHubDeps {
  registry: Registry;
  getSessionsRoot: () => string;
  broadcast: () => Promise<void>;
}

/**
 * The per-session lineage-dir watchers and the throttled sidebar broadcast
 * their file events trigger (issue #187). Owns the inotify handles and the
 * broadcast pacing alone; the manager owns the sessions.
 */
export class WatcherHub {
  private readonly watchers = new Map<string, () => void>();
  private broadcastAt = 0;
  private broadcastTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: WatcherHubDeps) {}

  start(record: OwnedSessionRecord): void {
    this.stop(record.tabId);
    const absDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    if (!fs.existsSync(absDir)) return;
    this.watchers.set(
      record.tabId,
      watchLineageDir(absDir, (event) => {
        if (event.kind === "vanished") {
          this.stop(record.tabId);
          void this.deps.broadcast();
          return;
        }
        void this.onSessionFile(record.tabId, event.filePath);
      }),
    );
  }

  stop(tabId: string): void {
    this.watchers.get(tabId)?.();
    this.watchers.delete(tabId);
  }

  startAll(records: readonly OwnedSessionRecord[]): void {
    for (const record of records) this.start(record);
  }

  stopForProject(projectCwd: string): void {
    for (const record of this.deps.registry.sessions) {
      if (record.projectCwd === projectCwd) this.stop(record.tabId);
    }
  }

  /**
   * Identity changes (first materialization, /new, /branch, a fresh title)
   * broadcast immediately; mtime-only churn is sidebar noise at turn rate and
   * gets a trailing throttle (issue #187).
   */
  broadcastPatch(immediate: boolean): void {
    if (this.broadcastTimer !== undefined) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = undefined;
    }
    const wait = this.broadcastAt + WATCHER_BROADCAST_MS - Date.now();
    if (immediate || wait <= 0) {
      this.broadcastAt = Date.now();
      void this.deps.broadcast();
      return;
    }
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      this.broadcastAt = Date.now();
      void this.deps.broadcast();
    }, wait);
    this.broadcastTimer.unref?.();
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
        this.broadcastPatch(
          patch.sessionId !== undefined || patch.cachedTitle !== undefined,
        );
      }
    } catch {
      // Mid-write or vanished — the next event (or state rebuild) retries.
    }
  }

  /** Closes every lineage watcher and drops the pending throttle timer. */
  disposeAll(): void {
    // Lineage watchers hold inotify fds; quit is the one path that must not
    // leave them to the OS — a cancelled quit keeps the app alive without them.
    for (const dispose of this.watchers.values()) dispose();
    this.watchers.clear();
    if (this.broadcastTimer !== undefined) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = undefined;
    }
  }
}
