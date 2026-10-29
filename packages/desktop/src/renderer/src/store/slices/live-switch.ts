// Live call switch state (ADR-0050, ADR-0070): the per-tab cancellation
// generation that outlives `discardTabRuntime`, the single-flight park/wake
// switch queue, and named per-tab timers. Imports no slice at runtime.
import type { RpcTabState } from "../types";
import { strField } from "../../lib/fields";

/** A named per-tab timer: the connecting watchdog (#827), the orphan
 *  restart settle deadline (#811), and the hold-to-talk release tail. */
export type LiveTimerSlot = "connect" | "orphan" | "talkTail";

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

const liveTimers = new Map<string, Partial<Record<LiveTimerSlot, number>>>();
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

/** Latest arm wins per (tab, slot). */
export function armLiveTimer(
  tabId: string,
  slot: LiveTimerSlot,
  ms: number,
  onFire: () => void,
): void {
  let slots = liveTimers.get(tabId);
  if (slots === undefined) {
    slots = {};
    liveTimers.set(tabId, slots);
  }
  const pending = slots[slot];
  if (pending !== undefined) window.clearTimeout(pending);
  const entry = slots;
  entry[slot] = window.setTimeout(() => {
    delete entry[slot];
    onFire();
  }, ms);
}

/** Returns true when a timer was pending (and is now cancelled). */
export function cancelLiveTimer(tabId: string, slot: LiveTimerSlot): boolean {
  const slots = liveTimers.get(tabId);
  const pending = slots?.[slot];
  if (slots === undefined || pending === undefined) return false;
  window.clearTimeout(pending);
  delete slots[slot];
  return true;
}

/** Every slot; idempotent. */
export function clearLiveTimers(tabId: string): void {
  const slots = liveTimers.get(tabId);
  if (slots === undefined) return;
  for (const id of Object.values(slots)) if (id !== undefined) window.clearTimeout(id);
  liveTimers.delete(tabId);
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
    if (request.mode === queued.mode && request.reviewKey === queued.reviewKey) {
      // Speech may be upgraded during the park wait, before start dispatch.
      if (request.briefOverview === true) queued.briefOverview = true;
      return "coalesced";
    }
    if (request.reviewKey !== queued.reviewKey || (request.mode === "wake" && queued.mode === "park"))
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

/** Tear down every live switch side channel for a tab whose runtime is dying.
 *  The generation BUMPS rather than clears, keeping late continuations
 *  invalid across a relaunch under the same tab id. */
export function disposeLiveSwitch(tabId: string): void {
  clearLiveTimers(tabId);
  liveSwitches.delete(tabId);
  bumpLiveVoiceGeneration(tabId);
}

/** Test seam: the whole module's per-tab state, fresh for the next test. */
export function resetLiveSwitchForTests(): void {
  for (const slots of liveTimers.values()) {
    for (const id of Object.values(slots)) if (id !== undefined) window.clearTimeout(id);
  }
  liveTimers.clear();
  liveSwitches.clear();
  liveGenerations.clear();
}
