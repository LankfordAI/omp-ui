import { watchGitHead } from "@omp-ui/core";

// Per-project gitdir watchers (issue #498), sibling of WatcherHub: WatcherHub
// owns the per-session lineage dirs, this owns one filesystem watch per
// registered project's git directory. Churn there — a terminal checkout, a
// commit, a branch created or deleted by anything outside this app — answers
// with onChanged, which MainBackend turns into a branch:changed event.

export interface HeadWatcherHubDeps {
  /** Called with the project path when its gitdir churned. */
  onChanged: (projectCwd: string) => void;
  /** Test seam; defaults to the core watcher. */
  watch?: typeof watchGitHead;
}

/**
 * The git-directory watchers for every registered project. `start` is
 * idempotent per path and tolerates in-flight overlap; a path that is not a
 * repository (or whose gitdir vanished before the watch) simply gets no
 * watcher, and a watcher error drops its entry so a later `start` retries.
 */
export class HeadWatcherHub {
  private readonly watchers = new Map<string, () => void>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly watch: typeof watchGitHead;

  constructor(private readonly deps: HeadWatcherHubDeps) {
    this.watch = deps.watch ?? watchGitHead;
  }

  /** Resolves once the path is watched (or known-unwatchable); never rejects. */
  start(projectCwd: string): Promise<void> {
    if (this.watchers.has(projectCwd)) return Promise.resolve();
    const inFlight = this.starting.get(projectCwd);
    if (inFlight !== undefined) return inFlight;
    const promise: Promise<void> = this.watch(
      projectCwd,
      () => this.deps.onChanged(projectCwd),
      { onGone: () => this.stop(projectCwd) },
    ).then(
      (dispose) => {
        if (this.starting.get(projectCwd) !== promise) {
          // stop()/disposeAll() ran while the probe was in flight.
          dispose();
          return;
        }
        this.starting.delete(projectCwd);
        this.watchers.set(projectCwd, dispose);
      },
      () => {
        // Not a repo / git probe failed: no watcher, silent — the chip
        // renders nothing for a non-git project anyway (#498).
        if (this.starting.get(projectCwd) === promise) this.starting.delete(projectCwd);
      },
    );
    this.starting.set(projectCwd, promise);
    return promise;
  }

  startAll(projectCwds: readonly string[]): void {
    for (const cwd of projectCwds) void this.start(cwd);
  }

  stop(projectCwd: string): void {
    this.starting.delete(projectCwd);
    this.watchers.get(projectCwd)?.();
    this.watchers.delete(projectCwd);
  }

  /** Closes every gitdir watch; quit must not leave the inotify fds behind. */
  disposeAll(): void {
    this.starting.clear();
    for (const dispose of this.watchers.values()) dispose();
    this.watchers.clear();
  }
}
