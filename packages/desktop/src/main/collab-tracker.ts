// The main-process Collab tracker (issue #686). omp owns hosting; this
// watches omp's own local registry (`omp collab list --json`) for rows whose
// pid belongs to one of OUR live PTY children, and broadcasts per-tab
// snapshots only on change. Commands are keystroke routes: share/stop write
// the `/collab` slash line into the tab's PTY — the same channel every other
// terminal input uses — and success is the registry row appearing on the next
// poll, never an assumed IPC round-trip. Foreign hosts (the user's own
// terminal omp) are never surfaced: rows only matter when their pid is ours.
import {
  CH,
  getCollabLink,
  listCollabHosts,
  type CollabAccess,
  type CollabCliDeps,
  type CollabHostRow,
  type CollabLinkResult,
  type CollabTabSnapshot,
  type CollabTabState,
} from "@omp-ui/core";

/** Poll cadence while at least one PTY tab is live. One short subprocess per tick. */
export const COLLAB_POLL_MS = 2_000;

/** How long a share waits for its registry row before surfacing the doubt. */
export const COLLAB_SETTLE_MS = 6_000;

/** One live PTY child: the tab and the OS pid of its omp process. */
export interface CollabLivePty {
  tabId: string;
  pid: number;
}

export interface CollabTrackerDeps {
  getOmpPath: () => string | null;
  /** The live PTY children — an empty set idles the poll loop. */
  livePtyEntries: () => Iterable<CollabLivePty>;
  /** The keystroke route into a PTY child (session-manager ptyWrite path). */
  writePty: (tabId: string, data: string) => void;
  send: (channel: string, ...args: unknown[]) => void;
  /** Registry seams; tests fake them. Defaults to the bundled-CLI runners. */
  cli?: CollabCliDeps;
  pollMs?: number;
  settleMs?: number;
}

interface SettleWaiter {
  access: CollabAccess;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class CollabTracker {
  /** Last broadcast state per tab; a tab absent from it is "off since last change". */
  private readonly lastStates = new Map<string, CollabTabState | null>();
  /** Shares awaiting their registry row, keyed by tab. */
  private readonly settles = new Map<string, SettleWaiter>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;

  constructor(private readonly deps: CollabTrackerDeps) {}

  /**
   * Call after every live-set change (PTY spawn, rejoin re-spawn, exit, delete,
   * quit). Starts the poll loop when a PTY child exists, idles it when none
   * remain, and reports a departed tab's state as off right away — its registry
   * row dies with the process, and waiting a poll to say so would strand the
   * dialog on a dead pid. A settle waiter on a departed tab fails immediately:
   * no row can arrive for a dead child.
   */
  noteLiveChange(): void {
    if (this.stopped) return;
    const entries = [...this.deps.livePtyEntries()];
    const hasPty = entries.length > 0;
    if (hasPty && this.timer === null) {
      this.timer = setInterval(() => void this.tick(), this.deps.pollMs ?? COLLAB_POLL_MS);
      this.timer.unref?.();
    } else if (!hasPty && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const liveTabIds = new Set(entries.map((entry) => entry.tabId));
    for (const tabId of [...this.lastStates.keys()]) {
      if (liveTabIds.has(tabId)) continue;
      if (this.lastStates.get(tabId) !== null) this.broadcast(tabId, null);
      this.lastStates.delete(tabId);
    }
    for (const tabId of this.settles.keys()) {
      if (liveTabIds.has(tabId)) continue;
      this.rejectSettle(tabId, new Error("the terminal ended before a Collab host appeared"));
    }
  }

  /** The `collabList` initial fetch: one snapshot per live PTY tab. */
  snapshots(): CollabTabSnapshot[] {
    return [...this.deps.livePtyEntries()].map(({ tabId }) => ({
      tabId,
      state: this.lastStates.get(tabId) ?? null,
    }));
  }

  /** Writes `/collab` or `/collab view` into the tab's TUI and waits for the row. */
  share(tabId: string, access: CollabAccess): Promise<void> {
    const entry = this.findLivePty(tabId);
    if (entry === null) return Promise.reject(new Error("this session is not a live terminal tab"));
    this.deps.writePty(tabId, access === "view" ? "/collab view\r" : "/collab\r");
    // Executor form (not Promise.withResolvers): desktop main's lib is ES2022.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settles.delete(tabId);
        reject(new Error("no Collab host appeared — check the terminal for omp's reply"));
      }, this.deps.settleMs ?? COLLAB_SETTLE_MS);
      this.settles.set(tabId, { access, timer, resolve, reject });
    });
  }

  /** Writes `/collab stop` into the tab's TUI; the poll confirms the row clears. */
  stop(tabId: string): void {
    const entry = this.findLivePty(tabId);
    if (entry === null) throw new Error("this session is not a live terminal tab");
    this.deps.writePty(tabId, "/collab stop\r");
  }

  /**
   * One generation-bound link for the tab's current host, by pid so omp binds
   * the current generation (rooms rotate on `/new`/`/resume`/branch switches).
   * Refusals reject with omp's own message.
   */
  async link(tabId: string, view: boolean): Promise<string> {
    const entry = this.findLivePty(tabId);
    if (entry === null) throw new Error("this session is not a live terminal tab");
    const ompPath = this.deps.getOmpPath();
    if (ompPath === null) throw new Error("omp binary not found");
    const result: CollabLinkResult = await getCollabLink(ompPath, String(entry.pid), view, this.deps.cli);
    if (!result.ok) throw new Error(result.message);
    return result.url;
  }

  /** Quit teardown: stop polling; the rows die with the processes. */
  dispose(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const waiter of this.settles.values()) clearTimeout(waiter.timer);
    this.settles.clear();
    this.lastStates.clear();
  }

  private async tick(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const ompPath = this.deps.getOmpPath();
      // Unknown (no binary, CLI hiccup): hold the last snapshot — flashing
      // every tab off on a transient probe failure is worse than lagging.
      const rows = ompPath === null ? null : await listCollabHosts(ompPath, this.deps.cli);
      if (this.stopped || rows === null) return;
      const byPid = new Map<number, CollabHostRow>();
      for (const row of rows) byPid.set(row.pid, row);
      for (const { tabId, pid } of this.deps.livePtyEntries()) {
        const row = byPid.get(pid);
        const state: CollabTabState | null =
          row === undefined
            ? null
            : {
                status: row.access,
                generation: row.generation,
                participants: row.participants,
                relayConnected: row.relayConnected,
                inputRequired: row.inputRequired,
              };
        if (!statesEqual(this.lastStates.get(tabId), state)) this.broadcast(tabId, state);
        const settle = this.settles.get(tabId);
        if (settle !== undefined && state !== null && state.status === settle.access) {
          clearTimeout(settle.timer);
          this.settles.delete(tabId);
          settle.resolve();
        }
      }
    } finally {
      this.polling = false;
      // The live set may have emptied while the probe ran; re-evaluate the loop.
      this.noteLiveChange();
    }
  }

  private rejectSettle(tabId: string, error: Error): void {
    const settle = this.settles.get(tabId);
    if (settle === undefined) return;
    clearTimeout(settle.timer);
    this.settles.delete(tabId);
    settle.reject(error);
  }

  private broadcast(tabId: string, state: CollabTabState | null): void {
    this.lastStates.set(tabId, state);
    this.deps.send(CH.onCollabChanged, tabId, state);
  }

  private findLivePty(tabId: string): CollabLivePty | null {
    for (const entry of this.deps.livePtyEntries()) {
      if (entry.tabId === tabId) return entry;
    }
    return null;
  }
}

function statesEqual(a: CollabTabState | null | undefined, b: CollabTabState | null): boolean {
  if (a === null && b === null) return true;
  if (a === undefined || a === null || b === null) return false;
  return (
    a.status === b.status &&
    a.generation === b.generation &&
    a.participants === b.participants &&
    a.relayConnected === b.relayConnected &&
    a.inputRequired === b.inputRequired
  );
}
