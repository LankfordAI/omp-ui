import { randomUUID } from "node:crypto";

import {
  isBlockingDialogMethod,
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
/**
 * The no-kill verdicts of the shared hibernation attempt. `rearm`: a guard is
 * in force or the probe said "not idle" — re-examine next window (issue #247).
 * The invalidating verdicts let the caller decide its own contract.
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
  probeResolve: ((state: { parked: number; streaming: boolean } | null) => void) | null;
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
  /** The manager's SIGTERM → grace → SIGKILL reap primitive. */
  hibernate: (tabId: string, entry: LiveEntry) => Promise<boolean>;
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
  /**
   * In-flight hibernation reaps, keyed by tabId: a resume or delete issued
   * mid-reap waits for the entry to leave `live` instead of deduping
   * against the dying process (issue #246, #296).
   */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  /** Unanswered blocking-dialog ids per tab (plan reviews included). */
  private readonly openRequests = new Map<string, Set<string>>();
  private readonly records = new Map<string, HibernateRecord>();

  constructor(private readonly deps: HibernationTrackerDeps) {}

  /** True while a renderer-routed dialog awaits the user's answer. */
  hasOpenRequests(tabId: string): boolean {
    return (this.openRequests.get(tabId)?.size ?? 0) > 0;
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
      if (
        !(typeof parked === "number" && Number.isFinite(parked)) ||
        typeof streaming !== "boolean"
      ) {
        resolve(null);
        return;
      }
      resolve({ parked, streaming });
      return;
    }
    switch (frame.type) {
      case "agent_start":
        this.deps.turns.start(tabId);
        // A new turn is activity: it answers every pending attention (issue #271).
        this.deps.attention?.turnStarted(tabId);
        break;
      case "agent_end": {
        this.deps.turns.end(tabId);
        if (rec.settleSuspendedUntil !== null) rec.settleSuspendedUntil = null;
        // Public agent_end is authoritative idle. Only a terminal end
        // announces completion; a pending plan gate or blocking answer owns
        // attention instead.
        if (frame.isTerminal !== false && !this.deps.awaitingHumanAnswer(tabId))
          this.deps.attention?.turnEnded(tabId);
        break;
      }
    }
    if (
      control !== null &&
      control.kind === "ext_request" &&
      // Only user-answer dialogs block hibernation; the other methods are
      // fire-and-forget state frames the renderer never replies to.
      typeof control.id === "string" &&
      isBlockingDialogMethod(control.method)
    ) {
      let open = this.openRequests.get(tabId);
      if (open === undefined) {
        open = new Set<string>();
        this.openRequests.set(tabId, open);
      }
      open.add(control.id);
    }
    // Responses to dialogs are commands (rpcSend), not frames: onSend
    // clears the bookkeeping. Any real frame re-arms the clock.
    rec.armed = true;
    this.armHibernateTimer(tabId);
  }

  onSend(tabId: string, cmd: RpcFrame): void {
    // Responses to dialogs are commands, not frames: this is where the
    // blocking-dialog bookkeeping clears.
    const control = normalizeControlFrame(cmd);
    if (control !== null && control.kind === "ext_response" && typeof control.id === "string") {
      this.openRequests.get(tabId)?.delete(control.id);
    }
  }

  onExit(tabId: string): void {
    this.clear(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  private clear(tabId: string): void {
    this.stopTimer(tabId);
    // A mid-probe exit settles the probe as "not idle": the attempt maps it
    // to a no-kill verdict, never to a kill on our own uncertainty.
    const rec = this.records.get(tabId);
    if (rec !== undefined) {
      clearTimeout(rec.probeTimer);
      rec.probeTimer = undefined;
      rec.probeResolve?.(null);
      rec.probeId = null;
      rec.probeResolve = null;
    }
    this.openRequests.delete(tabId);
    // The in-flight reap is NOT dropped here: exit fires before the reap
    // promise settles, and a delete or resume arriving in that gap must
    // still wait it out (issue #246, #296). The attempt's finally and
    // disposeAll own the removal.
    this.records.delete(tabId);
  }

  private stopTimer(tabId: string): void {
    const timer = this.timers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(tabId);
  }

  /** For killAll. */
  disposeAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.openRequests.clear();
    this.inFlight.clear();
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
   * recency mirrors the sidebar order — `cachedModified ?? launchedAt`, ties
   * to the earlier registry record. Dormant and terminal sessions count; a
   * dormant newest session already satisfies the guarantee.
   */
  private isLastActiveInProject(tabId: string): boolean {
    const sessions = this.deps.registry.sessions;
    const record = sessions.find((s) => s.tabId === tabId);
    if (!record) return false;
    const recency = (s: OwnedSessionRecord): string => s.cachedModified ?? s.launchedAt;
    const mine = recency(record);
    const myIndex = sessions.indexOf(record);
    return !sessions.some(
      (other, i) =>
        i !== myIndex &&
        other.projectCwd === record.projectCwd &&
        (recency(other) > mine || (recency(other) === mine && i < myIndex)),
    );
  }

  /** True when a kill cannot lose work or an in-flight exchange. */
  private hibernable(
    entry: LiveEntry,
    tabId: string,
    policy: "idle" | "plan-handoff",
  ): boolean {
    if (entry.kind !== "rpc-ui") return false;
    const rec = this.recordFor(tabId);
    if (!rec.armed) return false; // still booting
    if (this.deps.turns.isRunning(tabId)) return false; // mid-turn
    if (this.deps.awaitingHumanAnswer(tabId)) return false; // plan/dialog awaiting an answer
    if (policy === "plan-handoff") return true;
    if (this.deps.isViewed(tabId)) return false; // the tab is being looked at (issue #266)
    if (this.isLastActiveInProject(tabId)) return false; // the project's last active session stays warm (issue #304)
    const until = rec.settleSuspendedUntil;
    if (until !== null) {
      if (Date.now() < until) return false; // post-verdict window
      rec.settleSuspendedUntil = null; // window lapsed
    }
    return true;
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
  ): Promise<{ parked: number; streaming: boolean } | null> {
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
   * The shared guard→probe→recheck→reap sequence. Callers own their entry
   * gates (timer, dedupe) and map the no-kill verdicts to their own policy.
   * The reap is registered in `inFlight` for its full duration so a
   * delete or resume for the same tab can wait it out (issue #246, #296).
   */
  private async attemptHibernate(
    tabId: string,
    entry: LiveEntry,
    policy: "idle" | "plan-handoff",
  ): Promise<HibernateOutcome> {
    if (!this.hibernable(entry, tabId, policy)) return "rearm";
    const state = await this.probeState(tabId, entry);
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return "setting-off";
    const current = this.deps.getLive(tabId);
    if (current !== entry) return current !== undefined ? "replaced" : "gone";
    if (state === null || state.parked > 0 || state.streaming) return "rearm";
    if (!this.hibernable(entry, tabId, policy)) return "rearm";
    const reap = this.deps.hibernate(tabId, entry);
    this.inFlight.set(tabId, reap);
    try {
      return { reaped: await reap };
    } finally {
      this.inFlight.delete(tabId);
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
    if ((await this.attemptHibernate(tabId, entry, "idle")) === "rearm") {
      this.armHibernateTimer(tabId);
    }
  }

  /**
   * Hibernates an idle planning source after a fresh implementation prompt was
   * accepted. The persisted handoff relation is the authorization boundary;
   * viewed-tab and post-verdict guards apply only to ordinary idle hibernation.
   */
  async attemptHandoff(
    sourceTabId: string,
    implementationTabId: string,
  ): Promise<boolean> {
    const source = this.deps.registry.sessions.find((record) => record.tabId === sourceTabId);
    if (source === undefined) throw new Error(`unknown plan source tab ${sourceTabId}`);
    const implementation = this.deps.registry.sessions.find(
      (record) => record.tabId === implementationTabId,
    );
    if (implementation === undefined) {
      throw new Error(`unknown plan implementation tab ${implementationTabId}`);
    }
    if (implementation.planImplementationSource?.sourceTabId !== sourceTabId) {
      throw new Error("plan implementation does not belong to the requested source");
    }
    if (source.projectCwd !== implementation.projectCwd) {
      throw new Error("plan source and implementation must belong to the same project");
    }
    if (source.mode !== "rpc-ui" || implementation.mode !== "rpc-ui") {
      throw new Error("plan source and implementation must use rpc-ui mode");
    }

    const entry = this.deps.getLive(sourceTabId);
    if (entry === undefined) return true;
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return false;
    const pending = this.inFlight.get(sourceTabId);
    if (pending !== undefined) return pending;
    if (!this.hibernable(entry, sourceTabId, "plan-handoff")) return false;

    // `gone` (the source already exited) reads as hibernated for the handoff;
    // every other no-kill verdict — including a survived SIGKILL — is false.
    const outcome = await this.attemptHibernate(sourceTabId, entry, "plan-handoff");
    if (outcome === "gone") return true;
    return typeof outcome === "object" ? outcome.reaped : false;
  }
}
