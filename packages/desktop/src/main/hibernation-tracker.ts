import { randomUUID } from "node:crypto";

import {
  agentEndAwaitsAsyncWork,
  isNonTerminalAgentEnd,
  isObject,
  normalizeControlFrame,
  type OwnedSessionRecord,
  type Registry,
  type RpcFrame,
} from "@omp-ui/core";
import type { Attention } from "./desktop-notifier";
import type { FrameObserver } from "./frame-observer";
import type { LiveEntry } from "./live-entry";
import type { TurnTracker } from "./turns";

/** Pre-kill get_state probe bound; a wedged child is left to the stall UX, not killed. */
const HIBERNATE_PROBE_TIMEOUT_MS = 5_000;
/** Post-verdict quiet window: the implementation prompt may still land (issue #246). */
const SETTLE_WINDOW_MS = 30 * 60 * 1_000;
/** Recheck interval for a snoozed session that was busy when parked (issue #1323). */
const SNOOZE_PARK_RETRY_MS = 60_000;
/** Reap intent: settle stamps `settledAtMs`; park leaves the session unsettled-dormant (#1323). */
export type HibernateIntent = "settle" | "park";
/**
 * The no-kill verdicts of the idle hibernation attempt. `rearm`: a guard is
 * in force or the probe said "not idle" — re-examine next window (issue #247).
 * The invalidating verdicts end the window: the current setting, a successor
 * process, or an exit owns the next check.
 */
type HibernateOutcome =
  | { reaped: boolean }
  | "rearm"
  | "setting-off"
  | "replaced"
  | "gone";

/**
 * Per-tab hibernation bookkeeping — moved off the LiveEntry bag (issue #297).
 */
interface HibernateRecord {
  /** A frame has passed through: the idle clock may arm (booting until then). */
  armed: boolean;
  /** Post-verdict quiet window (issue #246); suspended until lapse or agent_end. */
  settleSuspendedUntil: number | null;
  /** In-flight pre-kill get_state probe; the matching response frame settles it. */
  probeId: string | null;
  /** Settles the probe's promise; null on timeout or failure. */
  probeResolve: ((state: { parked: number; streaming: boolean; asyncWork: boolean } | null) => void) | null;
  /** The probe's fallback timer; owned by the record, cleared on settle or teardown. */
  probeTimer: NodeJS.Timeout | undefined;
}

export interface HibernationTrackerDeps {
  registry: Registry;
  send: (channel: string, ...args: unknown[]) => void;
  broadcast: () => Promise<void>;
  attention?: Attention;
  turns: TurnTracker;
  getLive: (tabId: string) => LiveEntry | undefined;
  awaitingHumanAnswer: (tabId: string) => boolean;
  isViewed: (tabId: string) => boolean;
  /**
   * True while omp reports an enabled, active goal (issue #381, ADR-0046) or a
   * live vibe worker. omp's continuation runs in the child, so hibernating here
   * would silently end autonomous work no renderer is watching.
   */
  preventsHibernation: (tabId: string) => boolean;
  /** The manager's SIGTERM → grace → SIGKILL reap primitive. */
  hibernate: (tabId: string, entry: LiveEntry, intent?: HibernateIntent) => Promise<boolean>;
  /** Runs the attempt behind the tab's op chain (issue #297). */
  runSerialized: (tabId: string, work: () => Promise<void>) => Promise<void>;
}

/**
 * Idle hibernation: idle rpc-ui sessions are killed and left dormant, then
 * woken through the ordinary resume path (issue #246).
 */
export class HibernationTracker implements FrameObserver {
  /** Idle-kill timers, keyed by tabId (issue #246). */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Snooze-park retry timers, keyed by tabId (issue #1323). */
  private readonly snoozeTimers = new Map<string, NodeJS.Timeout>();
  private readonly records = new Map<string, HibernateRecord>();

  constructor(private readonly deps: HibernationTrackerDeps) {}

  /**
   * Snooze park (issue #1323): any live rpc-ui session with `record.snoozed`
   * should hibernate without settling as soon as it is safe. The initial
   * attempt bypasses `isViewed` because the user often snoozes the active tab;
   * if busy, retries on terminal `agent_end` and every 60 s while snoozed.
   */
  requestSnoozePark(tabId: string): void {
    const entry = this.deps.getLive(tabId);
    if (!entry || entry.kind !== "rpc-ui") return;
    this.stopSnoozeTimer(tabId);
    void this.deps.runSerialized(tabId, () => this.attemptSnoozePark(tabId, true));
  }
  /**
   * Post-verdict hibernation suspension (issue #246): between the verdict
   * and the implementation prompt the process is momentarily quiet.
   */
  suspendForVerdict(tabId: string): void {
    const rec = this.recordFor(tabId);
    rec.settleSuspendedUntil = Date.now() + SETTLE_WINDOW_MS;
    // A rejected plan leaves the session silent — no frame would re-arm
    // the check, so schedule one at the window's lapse (issue #247). Any
    // real frame re-arms over it and resets the clock.
    this.scheduleHibernateCheck(tabId, SETTLE_WINDOW_MS);
  }

  /**
   * Every rpc frame updates hibernation state in one place and re-arms the
   * idle clock. The setting is re-read on every arm, so a Settings change
   * takes effect at the next activity — no separate re-arm path.
   */
  onFrame(tabId: string, frame: RpcFrame): void {
    const entry = this.deps.getLive(tabId);
    if (!entry || entry.kind !== "rpc-ui") return;
    if (typeof frame !== "object" || frame === null) return;
    const control = normalizeControlFrame(frame);
    const rec = this.recordFor(tabId);
    // The probe's own response: settle it and do NOT reset the idle clock —
    // probe traffic is our own, and resetting would postpone every hibernation
    // attempt by its own probe.
    if (
      control !== null &&
      control.kind === "response" &&
      rec.probeId !== null &&
      control.id === rec.probeId
    ) {
      rec.probeId = null;
      clearTimeout(rec.probeTimer);
      rec.probeTimer = undefined;
      const resolve = rec.probeResolve;
      rec.probeResolve = null;
      if (resolve === null) return;
      if (control.success === false) {
        resolve(null);
        return;
      }
      // Command responses nest their payload under `data` (same tolerant
      // unwrap as the renderer's respData). Strictness is the documented
      // intent (see probeState): a missing or malformed field means "cannot
      // verify idle" → null → no-kill, never a defaulted "idle".
      const data = isObject(control.data) ? control.data : control.frame;
      const parked = data.queuedMessageCount;
      const streaming = data.isStreaming;
      const asyncWork = data.hasPendingAsyncWork;
      if (
        !(typeof parked === "number" && Number.isFinite(parked)) ||
        typeof streaming !== "boolean" ||
        typeof asyncWork !== "boolean"
      ) {
        resolve(null);
        return;
      }
      resolve({ parked, streaming, asyncWork });
      return;
    }
    switch (frame.type) {
      case "agent_start":
        this.deps.turns.start(tabId);
        // A new turn is activity: it answers every pending attention (issue #271).
        this.deps.attention?.turnStarted(tabId);
        break;
      case "agent_end": {
        // A non-terminal end is a loop pause inside an open run (issue #1192):
        // the latch stays set, so hibernation's mid-turn guard keeps the
        // process warm while background work can still wake it. The pause's
        // awaitingAsyncWork publishes as the summary's waiting level (#1204).
        if (isNonTerminalAgentEnd(frame)) {
          this.deps.turns.pause(tabId, agentEndAwaitsAsyncWork(frame));
          break;
        }
        this.deps.turns.end(tabId);
        if (rec.settleSuspendedUntil !== null) rec.settleSuspendedUntil = null;
        const snoozed = this.isRecordSnoozed(tabId);
        // Public agent_end is authoritative idle. Only a terminal end
        // announces completion; a pending plan gate, blocking answer, or
        // snoozed drain suppresses turn-complete attention (#1323).
        if (!snoozed && !this.deps.awaitingHumanAnswer(tabId))
          this.deps.attention?.turnEnded(tabId);
        if (snoozed) {
          this.stopSnoozeTimer(tabId);
          void this.deps.runSerialized(tabId, () => this.attemptSnoozePark(tabId, false));
        }
        break;
      }
    }
    // Blocking-dialog bookkeeping now lives in DialogGateTracker (#555).
    // Any real frame re-arms the clock.
    rec.armed = true;
    this.armHibernateTimer(tabId);
  }


  onExit(tabId: string): void {
    this.clear(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  private clear(tabId: string): void {
    this.stopTimer(tabId);
    this.stopSnoozeTimer(tabId);
    // to a no-kill verdict, never to a kill on our own uncertainty.
    const rec = this.records.get(tabId);
    if (rec !== undefined) {
      clearTimeout(rec.probeTimer);
      rec.probeTimer = undefined;
      rec.probeResolve?.(null);
      rec.probeId = null;
      rec.probeResolve = null;
    }
    // The running reap is not disturbed here: exit fires before the reap
    // promise settles, and the tab's op chain already makes a delete or
    // resume arriving in that gap wait it out (issue #246, #296).
    this.records.delete(tabId);
  }

  private stopTimer(tabId: string): void {
    const timer = this.timers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(tabId);
  }

  private stopSnoozeTimer(tabId: string): void {
    const timer = this.snoozeTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.snoozeTimers.delete(tabId);
  }

  /** For killAll. */
  disposeAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.snoozeTimers.values()) clearTimeout(timer);
    this.snoozeTimers.clear();
    for (const rec of this.records.values()) clearTimeout(rec.probeTimer);
    this.records.clear();
  }

  private recordFor(tabId: string): HibernateRecord {
    let rec = this.records.get(tabId);
    if (rec === undefined) {
      rec = {
        armed: false,
        settleSuspendedUntil: null,
        probeId: null,
        probeResolve: null,
        probeTimer: undefined,
      };
      this.records.set(tabId, rec);
    }
    return rec;
  }

  /**
   * True while `tabId` is its project's most recently active owned session.
   * The last active session in each project never idle-hibernates (issue #304):
   * the key is `cachedModified ?? launchedAt`, ties to the earlier registry
   * record (open order governs the sidebar; this exemption tracks activity).
   * Dormant and terminal sessions count; a dormant newest session already
   * satisfies the guarantee. Every Chat counts as one group: at most the
   * freshest chat stays warm (issue #894).
   */
  private isLastActiveInProject(tabId: string): boolean {
    const sessions = this.deps.registry.sessions;
    const record = sessions.find((s) => s.tabId === tabId);
    if (!record) return false;
    // Routine runs neither win nor steal a project's last-active warmth slot (#1253, ADR-0100).
    if (record.routine !== null) return false;
    const recency = (s: OwnedSessionRecord): string => s.cachedModified ?? s.launchedAt;
    const mine = recency(record);
    const myIndex = sessions.indexOf(record);
    return !sessions.some(
      (other, i) =>
        i !== myIndex &&
        other.routine === null &&
        other.chat === record.chat &&
        (record.chat || other.projectCwd === record.projectCwd) &&
        (recency(other) > mine || (recency(other) === mine && i < myIndex)),
    );
  }

  private isRecordSnoozed(tabId: string): boolean {
    return this.deps.registry.sessions.find((s) => s.tabId === tabId)?.snoozed === true;
  }

  /** True while a held prompt is waiting on live limit telemetry (`sendAtMs === null`). */
  private awaitsHeldPromptLimits(tabId: string): boolean {
    const held = this.deps.registry.sessions.find((s) => s.tabId === tabId)?.heldPrompt ?? null;
    return held !== null && held.sentAtMs === null && held.sendAtMs === null;
  }

  /** Core safety guards shared by idle hibernation and snooze-park (#1323). */
  private safeToHibernate(entry: LiveEntry, tabId: string, opts: { ignoreViewed?: boolean } = {}): boolean {
    if (entry.kind !== "rpc-ui") return false;
    const rec = this.recordFor(tabId);
    if (!rec.armed) return false; // still booting
    if (this.deps.turns.isRunning(tabId)) return false; // mid-turn
    if (this.deps.awaitingHumanAnswer(tabId)) return false; // plan/dialog awaiting an answer
    // An active goal or live vibe worker runs omp's continuation in the child;
    // idling out here would silently end autonomous work no renderer watches
    // (issue #381, #683).
    if (this.deps.preventsHibernation(tabId)) return false;
    if (!opts.ignoreViewed && this.deps.isViewed(tabId)) return false; // the tab is being looked at (issue #266)
    return true;
  }

  /** True when a kill cannot lose work or an in-flight exchange. */
  private hibernable(entry: LiveEntry, tabId: string): boolean {
    if (!this.safeToHibernate(entry, tabId)) return false;
    if (this.isLastActiveInProject(tabId)) return false; // the project's last active session stays warm (issue #304)
    const rec = this.recordFor(tabId);
    const until = rec.settleSuspendedUntil;
    if (until !== null) {
      if (Date.now() < until) return false; // post-verdict window
      rec.settleSuspendedUntil = null; // window lapsed
    }
    return true;
  }

  /** Safety check for snooze-park: bypasses idle-minute/last-active/verdict guards (#1323). */
  private snoozeParkable(entry: LiveEntry, tabId: string, ignoreViewed: boolean): boolean {
    if (!this.isRecordSnoozed(tabId)) return false;
    if (this.awaitsHeldPromptLimits(tabId)) return false;
    return this.safeToHibernate(entry, tabId, { ignoreViewed });
  }
  /**
   * Resets the idle clock. Arms regardless of guards (issue #247): the check
   * re-verifies every guard itself, so a guard that lapses while the session
   * is quiet is re-examined one window later. Arming only while hibernable
   * was the silent stick: nothing but a child frame arms, and a quiet
   * session produces none.
   */
  private armHibernateTimer(tabId: string): void {
    this.scheduleHibernateCheck(tabId, this.deps.registry.getSetting("hibernateIdleMinutes") * 60_000);
  }

  /**
   * One pending check per tab; a 0 setting means no check at all. Unref'd:
   * a housekeeping timer must never hold the process open (quit clears them
   * anyway via killAll), and tests that verdict/arm without fake timers must
   * not leak a 30-minute real timer into the worker teardown.
   */
  private scheduleHibernateCheck(tabId: string, delayMs: number): void {
    clearTimeout(this.timers.get(tabId));
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return;
    const timer = setTimeout(
      () => void this.deps.runSerialized(tabId, () => this.attemptIdle(tabId)),
      delayMs,
    );
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(tabId, timer);
  }

  /**
   * Live check right before the kill: parked work or streaming means "not
   * really idle". Settled by the matching response frame in
   * onFrame; null on timeout or failure — never kill on our own
   * uncertainty (a wedged session stays with the renderer's stall UX).
   */
  private probeState(
    tabId: string,
    entry: LiveEntry,
  ): Promise<{ parked: number; streaming: boolean; asyncWork: boolean } | null> {
    const rec = this.recordFor(tabId);
    if (entry.kind !== "rpc-ui") return Promise.resolve(null);
    const rpc = entry.rpc;
    if (rpc === null) return Promise.resolve(null);
    // Executor form (not Promise.withResolvers): the node tsconfig lib is
    // ES2022.
    const id = randomUUID();
    return new Promise((resolve) => {
      rec.probeId = id;
      rec.probeResolve = resolve;
      // The fallback timer is owned by the record (same bounded-wait posture
      // as core's settledWithin): the matching response frame or a teardown
      // clears it, so an early settle never leaves a dangling 5 s handle.
      const timer = setTimeout(() => {
        rec.probeTimer = undefined;
        if (rec.probeId !== id) return; // settled in the meantime
        rec.probeId = null;
        rec.probeResolve = null;
        resolve(null);
      }, HIBERNATE_PROBE_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      rec.probeTimer = timer;
      rpc.send({ type: "get_state", id });
    });
  }

  /**
   * The idle guard→probe→recheck→reap sequence. The caller owns the entry
   * gate (timer) and maps the no-kill verdicts to the re-arm policy. The
   * attempt runs on the tab's op chain, so a delete or resume issued mid-reap
   * waits it out instead of deduping against the dying process
   * (issue #246, #296).
   */
  private async attemptHibernate(tabId: string, entry: LiveEntry): Promise<HibernateOutcome> {
    if (!this.hibernable(entry, tabId)) return "rearm";
    const state = await this.probeState(tabId, entry);
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return "setting-off";
    const current = this.deps.getLive(tabId);
    if (current !== entry) return current !== undefined ? "replaced" : "gone";
    // A child subagent turn must not be reaped with its parent (issue #684).
    // A foreground child keeps the root streaming (covered by `streaming`);
    // a background child is an asyncJobManager job — running or parked with
    // a live job — and `hasPendingAsyncWork` reports exactly that. The field
    // is binary-verified in the get_state payload; strict presence keeps a
    // stale omp (pre-field) on the safe side: null verdict → rearm, no kill.
    if (state === null || state.parked > 0 || state.streaming || state.asyncWork)
      return "rearm";
    if (!this.hibernable(entry, tabId)) return "rearm";
    const intent: HibernateIntent = this.isRecordSnoozed(tabId) ? "park" : "settle";
    return { reaped: await this.deps.hibernate(tabId, entry, intent) };
  }

  private scheduleSnoozeRetry(tabId: string): void {
    this.stopSnoozeTimer(tabId);
    if (!this.isRecordSnoozed(tabId)) return;
    const timer = setTimeout(
      () => void this.deps.runSerialized(tabId, () => this.attemptSnoozePark(tabId, false)),
      SNOOZE_PARK_RETRY_MS,
    );
    if (typeof timer.unref === "function") timer.unref();
    this.snoozeTimers.set(tabId, timer);
  }

  private async attemptSnoozePark(tabId: string, ignoreViewed: boolean): Promise<void> {
    this.snoozeTimers.delete(tabId);
    if (!this.isRecordSnoozed(tabId)) return;
    const entry = this.deps.getLive(tabId);
    if (!entry || entry.kind !== "rpc-ui") return;
    if (!this.snoozeParkable(entry, tabId, ignoreViewed)) {
      this.scheduleSnoozeRetry(tabId);
      return;
    }
    const state = await this.probeState(tabId, entry);
    if (!this.isRecordSnoozed(tabId)) return;
    const current = this.deps.getLive(tabId);
    if (current !== entry) return;
    if (state === null || state.parked > 0 || state.streaming || state.asyncWork) {
      this.scheduleSnoozeRetry(tabId);
      return;
    }
    if (!this.snoozeParkable(entry, tabId, ignoreViewed)) {
      this.scheduleSnoozeRetry(tabId);
      return;
    }
    if (!(await this.deps.hibernate(tabId, entry, "park"))) {
      this.scheduleSnoozeRetry(tabId);
    }
  }

  /**
   * Idle window elapsed: run the shared attempt. Re-arm only on the
   * re-examination verdicts (issue #247) — guards lapse on their own clocks,
   * and a quiet session has no frames to re-arm the check.
   */
  private async attemptIdle(tabId: string): Promise<void> {
    this.timers.delete(tabId);
    // The setting may have flipped to off since the timer armed.
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return;
    const entry = this.deps.getLive(tabId);
    if (!entry || entry.kind !== "rpc-ui") return;
    // Guard-in-force and not-idle verdicts re-arm (issue #247): guards lapse
    // on their own clocks, and a quiet session has no frames to re-arm. The
    // invalidating verdicts (setting off, entry stale) do not: the current
    // config or the successor's own paths own the next check.
    if ((await this.attemptHibernate(tabId, entry)) === "rearm") {
      this.armHibernateTimer(tabId);
    }
  }
}
