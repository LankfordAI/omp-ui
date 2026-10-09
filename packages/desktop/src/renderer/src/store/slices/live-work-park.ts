// Work-parking module state (issue #815): the live call parks while a
// delegated backend turn works, and the wake reopens it. Everything here is
// process-local machinery, never intent: the per-tab cancellation generation
// must OUTLIVE `discardTabRuntime` (a runtime re-created under the same tab id
// can never match a continuation's captured generation), and the timer and
// switch maps are plain per-tab side channels dropped with the tab. The
// callbacks that fire live in frame-reduction.ts, which owns what a firing
// timer dispatches; this module only owns the state and the arm/cancel/
// coalescing discipline. Import direction: slices import this module; it
// imports no slice.

/** One tab's work-park timers, per slot; `undefined` slot = not armed. */
export interface LiveWorkTimerSlots {
  quiet?: number;
  cap?: number;
}

/** The operation a switch cycle performs: `park` closes the call and stops;
 *  `wake` parks first when the call is still open, then starts. A wake
 *  coalesced behind a running park supersedes it — the world the park was
 *  scheduled for is already over. */
export type LiveSwitchMode = "park" | "wake";

/** One tab's switch coalescing entry: the entry's existence means a cycle
 *  is running; a further request only records `again` (and upgrades `wake`). */
export interface LiveSwitchEntry {
  again: boolean;
  mode: LiveSwitchMode;
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

/** Clear both work timers; idempotent. Called at every park, every explicit
 *  stop, the switch operation's start step, every `agent_end` that carried
 *  the flag, and `discardTabRuntime`. */
export function clearLiveWorkTimers(tabId: string): void {
  const slots = liveWorkTimers.get(tabId);
  if (slots === undefined) return;
  if (slots.quiet !== undefined) window.clearTimeout(slots.quiet);
  if (slots.cap !== undefined) window.clearTimeout(slots.cap);
  liveWorkTimers.delete(tabId);
}

/** Claim the tab's single-flight switch slot. The entry's existence means
 *  a runner owns the tab, so any request here only records a
 *  re-evaluation (a queued wake upgrades a queued park: the world the park
 *  was scheduled for is already over) and returns the string "coalesced";
 *  the idle tab gets the fresh entry to run. */
export function claimLiveSwitch(
  tabId: string,
  mode: LiveSwitchMode,
): LiveSwitchEntry | "coalesced" {
  const existing = liveSwitches.get(tabId);
  if (existing !== undefined) {
    existing.again = true;
    if (mode === "wake") existing.mode = "wake";
    return "coalesced";
  }
  const fresh: LiveSwitchEntry = { again: false, mode };
  liveSwitches.set(tabId, fresh);
  return fresh;
}

/** One pass finished: keep the slot claimed and hand back the entry when a
 *  request arrived during the pass (its `again` flag resets), or drop the
 *  slot and return null. */
export function finishLiveSwitch(tabId: string): LiveSwitchEntry | null {
  const entry = liveSwitches.get(tabId);
  if (entry === undefined) return null;
  if (!entry.again) {
    liveSwitches.delete(tabId);
    return null;
  }
  entry.again = false;
  return entry;
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
  }
  liveWorkTimers.clear();
  liveSwitches.clear();
  liveGenerations.clear();
}
