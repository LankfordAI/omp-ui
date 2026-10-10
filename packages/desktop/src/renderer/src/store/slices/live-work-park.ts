// Work-parking module state (issue #815): the live call parks while a
// delegated backend turn works, and the wake reopens it. Everything here is
// process-local machinery, never intent: the per-tab cancellation generation
// must OUTLIVE `discardTabRuntime` (a runtime re-created under the same tab id
// can never match a continuation's captured generation), and the timer and
// switch maps are plain per-tab side channels dropped with the tab. The
// callbacks live in session-params.ts; this leaf owns only cancellation,
// timers and the one shared switch queue. It imports no slice at runtime.
import type { RpcTabState } from "../types";
import { strField } from "../../lib/fields";

/** One tab's work-park timers, per slot; `undefined` slot = not armed. */
 export interface LiveWorkTimerSlots {
   quiet?: number;
   cap?: number;
  /** Cadence timer for interstitial progress reports (#826). */
  progress?: number;
 }

/** The operation a switch cycle performs: `park` closes the call and stops;
 *  `wake` parks first when the call is still open, then starts. A wake
 *  coalesced behind a running park supersedes it — the world the park was
 *  scheduled for is already over. */
export type LiveSwitchMode = "park" | "wake";

export interface LiveSwitchRequest {
  mode: LiveSwitchMode;
  /** A loaded source key; null requires retirement, omitted re-evaluates. */
  reviewKey?: string | null;
  briefOverview?: boolean;
  /** A progress-report wake (#826): speaks one update for a parked work
   *  turn, never supersedes a final-answer wake in the queue. */
  progress?: boolean;
}

/** Runtime identity and generation are captured for every queued pass. */
export interface LiveSwitchEntry {
  request: LiveSwitchRequest;
  runtime: object;
  generation: number;
  again?: LiveSwitchRequest;
}

export function planReviewGateKey(review: NonNullable<RpcTabState["planReview"]>): string {
  return JSON.stringify([
    strField(review.frame, "id"),
    review.request.planAbsPath,
    review.request.sourceHash ?? null,
  ]);
}

const liveWorkTimers = new Map<string, LiveWorkTimerSlots>();
const liveSwitches = new Map<string, LiveSwitchEntry>();
const liveGenerations = new Map<string, number>();

/** The tab's current cancellation generation; 0 until first bumped. */
export function liveVoiceGeneration(tabId: string): number {
  return liveGenerations.get(tabId) ?? 0;
}

/** Invalidate every async continuation created under the tab's old
 *  generation. Synchronous; called by an explicit stop, runtime teardown,
 *  and every switch start dispatch. */
export function bumpLiveVoiceGeneration(tabId: string): void {
  liveGenerations.set(tabId, liveVoiceGeneration(tabId) + 1);
}

/** Arm the quiet deadline; a pending quiet timer is never re-armed or
 *  pushed out — levels are edge-triggered, so the first quiet frame after a
 *  loud one owns the deadline and only a loud frame cancels it. */
export function armLiveWorkQuietTimer(
  tabId: string,
  ms: number,
  onFire: () => void,
): void {
  let slots = liveWorkTimers.get(tabId);
  if (slots === undefined) {
    slots = {};
    liveWorkTimers.set(tabId, slots);
  }
  if (slots.quiet !== undefined) return;
  const entry = slots;
  entry.quiet = window.setTimeout(() => {
    entry.quiet = undefined;
    onFire();
  }, ms);
}

/** Cancel the quiet deadline (a loud output frame, or any teardown). */
export function cancelLiveWorkQuietTimer(tabId: string): void {
  const slots = liveWorkTimers.get(tabId);
  if (slots?.quiet === undefined) return;
  window.clearTimeout(slots.quiet);
  slots.quiet = undefined;
}

/** Arm the hard cap; the latest arm wins (one per accepted work-park). */
export function armLiveWorkCapTimer(
  tabId: string,
  ms: number,
  onFire: () => void,
): void {
  let slots = liveWorkTimers.get(tabId);
  if (slots === undefined) {
    slots = {};
    liveWorkTimers.set(tabId, slots);
  }
  if (slots.cap !== undefined) window.clearTimeout(slots.cap);
  const entry = slots;
  entry.cap = window.setTimeout(() => {
    entry.cap = undefined;
    onFire();
  }, ms);
}

/** Arm the progress-report cadence (#826); the latest arm wins — one
 *  interval per delegated turn, re-armed from each fire callback. */
export function armLiveProgressTimer(
  tabId: string,
  ms: number,
  onFire: () => void,
): void {
  let slots = liveWorkTimers.get(tabId);
  if (slots === undefined) {
    slots = {};
    liveWorkTimers.set(tabId, slots);
  }
  if (slots.progress !== undefined) window.clearTimeout(slots.progress);
  const entry = slots;
  entry.progress = window.setTimeout(() => {
    entry.progress = undefined;
    onFire();
  }, ms);
}

/** Clear both work timers; idempotent. Called at every park, every explicit
 *  stop, the switch operation's start step, every `agent_end` that carried
 *  the flag, and `discardTabRuntime`. */
export function clearLiveWorkTimers(tabId: string): void {
  const slots = liveWorkTimers.get(tabId);
  if (slots === undefined) return;
  if (slots.quiet !== undefined) window.clearTimeout(slots.quiet);
  if (slots.cap !== undefined) window.clearTimeout(slots.cap);
  if (slots.progress !== undefined) window.clearTimeout(slots.progress);
  liveWorkTimers.delete(tabId);
}

/** Clear only the park-window timers (quiet deadline + cap); the
 *  progress-report cadence survives a park — the report's own re-park and
 *  the initial delegated park both run through the park path (#826). */
export function clearLiveWorkWindowTimers(tabId: string): void {
  const slots = liveWorkTimers.get(tabId);
  if (slots === undefined) return;
  if (slots.quiet !== undefined) window.clearTimeout(slots.quiet);
  if (slots.cap !== undefined) window.clearTimeout(slots.cap);
}

/** Wake outranks an ordinary park; a new review replaces obsolete work. */
export function claimLiveSwitch(
  tabId: string,
  request: LiveSwitchRequest,
  runtime: object,
): LiveSwitchEntry | "coalesced" {
  const existing = liveSwitches.get(tabId);
  if (existing !== undefined && existing.runtime === runtime) {
    const queued = existing.again ?? existing.request;
    if (request.mode === "park" && queued.mode === "wake" && request.reviewKey === undefined)
      return "coalesced";
    // Progress reports never outrank an answer (#826): a report coalesces
    // behind any queued wake, and a final wake replaces a queued report —
    // with a generation bump, mirroring the wake-behind-park rule, so the
    // report's own start (if dispatched) cannot finish over the answer.
    if (queued.mode === "wake" && request.mode === "wake") {
      if (request.progress === true) return "coalesced";
      if (queued.progress === true) {
        bumpLiveVoiceGeneration(tabId);
        existing.again = request;
        return "coalesced";
      }
    }
    if (request.mode === queued.mode && request.reviewKey === queued.reviewKey) {
      // Speech may be upgraded during the park wait, before start dispatch.
      if (request.briefOverview === true) queued.briefOverview = true;
      return "coalesced";
    }
    if (request.reviewKey !== queued.reviewKey ||
      // A progress wake lets a running park complete — bumping would abort
      // the park mid-flight and leave the mic open (#826).
      (request.mode === "wake" && queued.mode === "park" && request.progress !== true))
      bumpLiveVoiceGeneration(tabId);
    existing.again = request;
    return "coalesced";
  }
  const fresh: LiveSwitchEntry = {
    request, runtime, generation: liveVoiceGeneration(tabId),
  };
  liveSwitches.set(tabId, fresh);
  return fresh;
}

/** An old runner may never release a replacement runner's slot. */
export function finishLiveSwitch(tabId: string, captured: LiveSwitchEntry): LiveSwitchEntry | null {
  if (liveSwitches.get(tabId) !== captured) return null;
  if (captured.again === undefined) {
    liveSwitches.delete(tabId);
    return null;
  }
  captured.request = captured.again;
  captured.again = undefined;
  captured.generation = liveVoiceGeneration(tabId);
  return captured;
}

export function cancelLiveSwitch(tabId: string): void {
  liveSwitches.delete(tabId);
}

/** Tear down every work-park side channel for a tab whose runtime is dying.
 *  The generation BUMPS rather than clears, keeping late continuations
 *  invalid across a relaunch under the same tab id. */
export function disposeLiveWorkPark(tabId: string): void {
  clearLiveWorkTimers(tabId);
  liveSwitches.delete(tabId);
  bumpLiveVoiceGeneration(tabId);
}

/** Test seam: the whole module's per-tab state, fresh for the next test. */
export function resetLiveWorkParkForTests(): void {
  for (const slots of liveWorkTimers.values()) {
    if (slots.quiet !== undefined) window.clearTimeout(slots.quiet);
    if (slots.cap !== undefined) window.clearTimeout(slots.cap);
    if (slots.progress !== undefined) window.clearTimeout(slots.progress);
  }
  liveWorkTimers.clear();
  liveSwitches.clear();
  liveGenerations.clear();
}
