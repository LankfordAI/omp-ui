import { CH, type Attention, type FrameObserver } from "@omp-ui/core";
import type { LiveEntry } from "../live-entry";

/** The frame-derived attention transitions the session trackers report. */
export interface AttentionSink {
  /** A turn started on this tab: activity answers every pending attention. */
  turnStarted(tabId: string): void;
  /** The last running turn ended and the session is idle (no gate/dialog pending). */
  turnEnded(tabId: string): void;
  /** A plan proposal was recorded as the tab's pending gate. */
  planProposed(tabId: string, planTitle: string): void;
  /** A verdict closed the tab's plan gate. */
  planSettled(tabId: string): void;
  /** The stall auto-continue guard paused at its cap (true) or re-armed (false). */
  stallPaused(tabId: string, paused: boolean): void;
  /** The tab's live process left `live` (exit, terminate, hibernation reap). */
  sessionExit(tabId: string): void;
}

/** For a SessionManager wired without a host attention sink (unit tests). */
export const NO_ATTENTION: AttentionSink = {
  turnStarted() {},
  turnEnded() {},
  planProposed() {},
  planSettled() {},
  stallPaused() {},
  sessionExit() {},
};

export interface AttentionTrackerDeps {
  send: (channel: string, ...args: unknown[]) => void;
  now?: () => number;
  /** A terminal tab has no frame stream to derive attention from; every setter is a no-op. */
  isPty: (tabId: string) => boolean;
}

/**
 * The host's per-tab attention level (issue #442): one neutral record per
 * tab, published on `attention:changed` and carried on the session summary,
 * so every client — the desktop notifier included — reads the same answer to
 * "does this session want me?". Precedence: a pending plan gate outranks a
 * finished turn; a new turn clears everything.
 */
export class AttentionTracker implements AttentionSink, FrameObserver<LiveEntry> {
  private readonly levels = new Map<string, Attention>();
  private readonly now: () => number;

  constructor(private readonly deps: AttentionTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  level(tabId: string): Attention | null {
    return this.levels.get(tabId) ?? null;
  }

  turnStarted(tabId: string): void {
    this.clear(tabId);
  }

  turnEnded(tabId: string): void {
    if (this.levels.get(tabId)?.kind === "plan-pending") return;
    this.set(tabId, "turn-complete", null);
  }

  planProposed(tabId: string, planTitle: string): void {
    this.set(tabId, "plan-pending", planTitle);
  }

  planSettled(tabId: string): void {
    if (this.levels.get(tabId)?.kind === "plan-pending") this.clear(tabId);
  }

  stallPaused(tabId: string, paused: boolean): void {
    if (paused) this.set(tabId, "stall-paused", null);
    else if (this.levels.get(tabId)?.kind === "stall-paused") this.clear(tabId);
  }

  sessionExit(tabId: string): void {
    this.clear(tabId);
  }

  onFrame(): void {}

  onExit(tabId: string): void {
    this.sessionExit(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  private set(tabId: string, kind: Attention["kind"], planTitle: string | null): void {
    if (this.deps.isPty(tabId)) return;
    const prev = this.levels.get(tabId);
    if (prev !== undefined && prev.kind === kind && prev.planTitle === planTitle) return;
    const next: Attention = {
      kind,
      planTitle,
      atMs: Math.max((prev?.atMs ?? -Infinity) + 1, this.now()),
    };
    this.levels.set(tabId, next);
    this.deps.send(CH.onAttentionChanged, tabId, next);
  }

  private clear(tabId: string): void {
    if (this.deps.isPty(tabId)) return;
    if (!this.levels.delete(tabId)) return;
    this.deps.send(CH.onAttentionChanged, tabId, null);
  }
}
