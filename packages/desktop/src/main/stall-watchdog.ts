import {
  CH,
  modelStreamCheckpointLabel,
  type Registry,
  type RpcFrame,
} from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";
import type { LiveEntry, RpcLiveEntry } from "./live-entry";
import { TurnCounter } from "./turns";

/**
 * Stream-stall watchdog sweep cadence (issue #248).
 */
const STALL_WATCH_TICK_MS = 15_000;

/**
 * One tab's model-stream silence, open-tool, and abort bookkeeping — moved
 * off the LiveEntry bag (issue #297).
 */
interface StallRecord {
  /** Start of the currently eligible model-stream silence interval. */
  silenceSince: number | null;
  /** Open local tool executions; the silence clock is suspended while > 0. */
  openToolCount: number;
  /** Label of the last model-stream checkpoint, for the abort notice. */
  checkpointLabel: string | null;
  /** Turns this live process has had aborted as stalled; appears in the notice. */
  abortCount: number;
}

export interface StallWatchdogDeps {
  registry: Registry;
  send: (channel: string, ...args: unknown[]) => void;
  broadcast: () => Promise<void>;
  turns: TurnCounter;
  getLive: (tabId: string) => LiveEntry | undefined;
  liveEntries: () => Iterable<[string, LiveEntry]>;
  awaitingHumanAnswer: (tabId: string) => boolean;
}

/**
 * Aborts a turn whose model stream has gone silently dead (issue #248).
 * Display-only detection (#228) assumed omp's idle watchdog recovers
 * stalls; OpenRouter's SSE keep-alives defeat it, so main carries the
 * backstop.
 */
export class StallWatchdog implements FrameObserver {
  /**
   * Tabs whose current live process had a turn aborted as stalled; sidebar
   * badge state. Lasts until the next turn starts (issue #255), a respawn,
   * or exit.
   */
  private readonly stalledTabs = new Set<string>();
  private readonly records = new Map<string, StallRecord>();
  /** One sweeping interval for all live tabs; arms lazily, unref'd. */
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly deps: StallWatchdogDeps) {}

  /** Whether the stall watchdog has aborted a turn on this live process. */
  isStreamStalled(tabId: string): boolean {
    return this.stalledTabs.has(tabId);
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    if (typeof frame !== "object" || frame === null) return;
    if (frame.type === "agent_start") {
      // Arm the sweep on the first turn (issue #248); the badge is a
      // call-to-action ("prompt to continue") and a new turn is that
      // continuation, whoever sent it (issue #255).
      this.ensureWatch();
      if (this.stalledTabs.delete(tabId)) void this.deps.broadcast();
    }
    this.observeActivity(tabId, frame);
  }

  onExit(tabId: string): void {
    this.clear(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  private clear(tabId: string): void {
    this.records.delete(tabId);
    this.stalledTabs.delete(tabId);
  }

  /** For killAll: clear the sweep interval and every badge. */
  disposeAll(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.records.clear();
    this.stalledTabs.clear();
  }

  private ensureWatch(): void {
    if (this.interval !== undefined) return;
    this.interval = setInterval(() => this.checkStalls(), STALL_WATCH_TICK_MS);
    if (typeof this.interval.unref === "function") this.interval.unref();
  }

  private checkStalls(): void {
    const thresholdSeconds = this.deps.registry.getSetting("streamStallAbortSeconds");
    if (thresholdSeconds <= 0) return;
    for (const [tabId, entry] of this.deps.liveEntries()) {
      if (entry.kind !== "rpc-ui") continue;
      if (this.deps.turns.running(tabId) === 0) continue;
      if (this.deps.awaitingHumanAnswer(tabId)) continue;
      // A running local tool is legitimately quiet on the provider stream —
      // a build, a test suite, a hub wait. While one is open the model owes
      // nothing, however long it runs (issue #253).
      const rec = this.records.get(tabId);
      if (rec === undefined || rec.openToolCount > 0) continue;
      const silenceSince = rec.silenceSince;
      if (silenceSince === null) continue;
      const now = Date.now();
      const quietMs = now - silenceSince;
      if (quietMs < thresholdSeconds * 1_000) continue;
      this.abortStalledTurn(tabId, entry, rec, quietMs, thresholdSeconds);
    }
  }

  private abortStalledTurn(
    tabId: string,
    entry: RpcLiveEntry,
    rec: StallRecord,
    quietMs: number,
    thresholdSeconds: number,
  ): void {
    const rpc = entry.rpc;
    if (rpc === null) return;
    // First fire wins: the notice quotes the silence observed at abort time.
    // Resetting the clock now is also what stops a refused abort from
    // re-firing every tick.
    rec.silenceSince = null;
    rec.abortCount += 1;
    this.stalledTabs.add(tabId);
    rpc.send({ type: "abort" });
    const minutes = Math.floor(thresholdSeconds / 60);
    const since = rec.checkpointLabel ?? "unknown";
    this.deps.send(CH.onRpcFrame, tabId, {
      type: "omp_ui_notice",
      level: "warn",
      source: "omp-ui",
      // Machine-readable: the renderer feeds this abort into stall
      // auto-continue (issue #254) — the turn end it produces reads
      // "aborted", which isStreamStallEnd can never classify.
      reason: "stall-abort",
      message:
        `omp-ui aborted a stalled turn #${rec.abortCount} — no model-stream activity ` +
        `for ${Math.round(quietMs / 1_000)}s (last: ${since}; window ${minutes}m). ` +
        `omp's provider watchdog never fired — OpenRouter's stream keep-alives can defeat it. ` +
        `Stall auto-continue resumes the turn if enabled; any prompt also continues it. ` +
        `Tune or disable under Settings → General → stall watchdog.`,
    });
    void this.deps.broadcast();
  }

  private observeActivity(tabId: string, frame: RpcFrame): void {
    const rec = this.recordFor(tabId);
    const type = frame.type;
    switch (type) {
      // No tool execution survives a turn boundary. An abort's teardown can
      // skip end frames for refused tools; a leaked count would suppress
      // the watchdog for the whole next turn.
      case "agent_start":
      case "agent_end":
        rec.openToolCount = 0;
        return;
      case "tool_execution_start":
        rec.openToolCount++;
        return;
      case "tool_execution_update":
        // A lost start frame must not leave the clock running against a
        // live tool; an update proves one is open.
        if (rec.openToolCount === 0) rec.openToolCount = 1;
        return;
      case "tool_execution_end":
        // Ghost ends (no matching start) exist; the transcript reducer
        // tolerates them too. Never let one underflow or rebase.
        if (rec.openToolCount === 0) return;
        rec.openToolCount--;
        if (rec.openToolCount === 0) {
          // The next model request starts here: give it a full window,
          // exactly like the "human answer received" rebase in rpcSend.
          rec.silenceSince = Date.now();
          rec.checkpointLabel = "tool execution finished";
        }
        return;
      // omp is legitimately quiet during compaction and retry backoff.
      // Rebase — never suspend: a wedged compaction/retried stream is a
      // real stall and must still trip the watchdog one window later.
      case "auto_compaction_start":
        rec.silenceSince = Date.now();
        rec.checkpointLabel = "compaction started";
        return;
      case "auto_compaction_end":
        rec.silenceSince = Date.now();
        rec.checkpointLabel = "compaction finished";
        return;
      case "auto_retry_start":
        rec.silenceSince = Date.now();
        rec.checkpointLabel = "retry scheduled";
        return;
      case "auto_retry_end":
        rec.silenceSince = Date.now();
        rec.checkpointLabel = "retry settled";
        return;
    }
    const label = modelStreamCheckpointLabel(frame);
    if (label !== null) {
      rec.silenceSince = Date.now();
      rec.checkpointLabel = label;
    }
  }

  private recordFor(tabId: string): StallRecord {
    let rec = this.records.get(tabId);
    if (rec === undefined) {
      rec = { silenceSince: null, openToolCount: 0, checkpointLabel: null, abortCount: 0 };
      this.records.set(tabId, rec);
    }
    return rec;
  }

  /**
   * A human answer unblocked a running turn: the model owes a fresh silence
   * window from here (the rebase rpcSend used to apply inline).
   */
  humanAnswered(tabId: string): void {
    const entry = this.deps.getLive(tabId);
    if (entry?.kind !== "rpc-ui") return;
    if (this.deps.turns.running(tabId) <= 0) return;
    const rec = this.recordFor(tabId);
    rec.silenceSince = Date.now();
    rec.checkpointLabel = "human answer received";
  }
}
