import { useSyncExternalStore } from "react";

/**
 * Transcript-scoped text scale (issue #30).
 *
 * App-level zoom stays disabled on purpose — the renderer is an app, not a
 * document (style.css) — but the transcript IS a document, so it gets its own
 * scale. It is a view preference like the inspector rail's collapse state,
 * not session state, so it lives outside the store; unlike the rail it must
 * survive a restart, hence localStorage.
 */
const KEY = "omp-ui.transcriptScale";

/** Discrete steps: predictable, and never small enough to be unreadable. */
export const SCALE_STEPS = [0.875, 1, 1.125, 1.25, 1.5] as const;

function load(): number {
  try {
    const raw = Number(window.localStorage.getItem(KEY));
    // Snap to a known step so a stale or hand-edited value can't wedge the
    // transcript at some arbitrary zoom with no keystroke that reaches it.
    if (SCALE_STEPS.includes(raw as (typeof SCALE_STEPS)[number])) return raw;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return 1;
}

let scale = load();
const listeners = new Set<() => void>();

function set(next: number): void {
  if (next === scale) return;
  scale = next;
  try {
    window.localStorage.setItem(KEY, String(next));
  } catch {
    // Persisting is best-effort; the in-memory value still applies.
  }
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current scale, live across every transcript view. */
export function useTranscriptScale(): number {
  return useSyncExternalStore(subscribe, () => scale);
}

/** One step larger (+1) or smaller (-1); clamps at the ends. */
export function stepTranscriptScale(direction: 1 | -1): void {
  const i = SCALE_STEPS.indexOf(scale as (typeof SCALE_STEPS)[number]);
  const next = SCALE_STEPS[Math.min(SCALE_STEPS.length - 1, Math.max(0, i + direction))];
  if (next !== undefined) set(next);
}

/** Sets an exact step (the settings page's select); off-scale values snap to 1. */
export function setTranscriptScale(next: number): void {
  set(SCALE_STEPS.includes(next as (typeof SCALE_STEPS)[number]) ? next : 1);
}

export function resetTranscriptScale(): void {
  set(1);
}
