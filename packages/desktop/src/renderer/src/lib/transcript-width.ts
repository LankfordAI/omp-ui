import { useSyncExternalStore } from "react";
import type { TranscriptWidth } from "@omp-ui/core/types";

/**
 * Transcript column width steps (issue #391; two-tier spread, issue #1059).
 *
 * The store syncs the persisted `transcriptWidth` setting from the backend and
 * this module repoints two CSS custom properties on the document root:
 * `--transcript-max` caps the centred transcript column and every chrome card
 * that shares its axis — the composer card, ApprovalCard, the extension
 * dialog card, and the transcript skeleton — while `--prose-max` keeps the
 * readable prose measure inside the column (issue #26's rule). Before #1059 a
 * single `ch` property served both planes, so the three steps differed by
 * ~150px total, "Full" left 300px gutters, and `ch` resolved per-consumer
 * against each element's own font. Column and chrome now speak pane pixels
 * (rem/%), prose keeps `ch`.
 */

export interface TranscriptWidthStep {
  id: TranscriptWidth;
  /** CSS length for --prose-max (issue #26's readable measure, ch). */
  proseMax: string;
  /** CSS length for --transcript-max (column + chrome cards, pane px). */
  transcriptMax: string;
}

export const TRANSCRIPT_WIDTHS: readonly TranscriptWidthStep[] = [
  { id: "comfortable", proseMax: "70ch", transcriptMax: "56rem" },
  { id: "wide", proseMax: "80ch", transcriptMax: "72rem" },
  { id: "full", proseMax: "88ch", transcriptMax: "100%" },
];

/**
 * The column cap as seen from inside the zoomed document surface. rem
 * lengths multiply by standardized CSS zoom, so divide up front to land on
 * transcriptMax chrome pixels and keep the composer card's edges aligned at
 * any text scale. `100%` resolves against the parent layout box, which zoom
 * does not scale — dividing a percentage would be wrong.
 */
export function columnCapFor(step: TranscriptWidthStep, scale: number): string {
  return step.transcriptMax === "100%"
    ? "100%"
    : `calc(${step.transcriptMax} / ${scale})`;
}

export const DEFAULT_TRANSCRIPT_WIDTH_ID: TranscriptWidth = "wide";

/**
 * Mirror of the store's `transcriptWidth`. The renderer needs the column cap
 * before the first backend round-trip resolves, so localStorage — not the
 * backend — is the read path here.
 */
const KEY = "omp-ui.transcriptWidth";

const DEFAULT_TRANSCRIPT_WIDTH: TranscriptWidthStep =
  TRANSCRIPT_WIDTHS.find((w) => w.id === DEFAULT_TRANSCRIPT_WIDTH_ID) ?? TRANSCRIPT_WIDTHS[0];

/** Unknown id (renamed step, hand-edited storage) degrades, never throws. */
export function resolveTranscriptWidth(id: string | undefined): TranscriptWidthStep {
  return TRANSCRIPT_WIDTHS.find((w) => w.id === id) ?? DEFAULT_TRANSCRIPT_WIDTH;
}

let current: TranscriptWidthStep = DEFAULT_TRANSCRIPT_WIDTH;
const listeners = new Set<() => void>();

/**
 * The single runtime writer. Guarded like `applyFontFamily`: the store calls
 * this during its own boot, and the store's tests run in vitest's node
 * environment with no `document` and no `localStorage`.
 */
export function applyTranscriptWidth(step: TranscriptWidthStep): void {
  current = step;

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.style.setProperty("--prose-max", step.proseMax);
    root.style.setProperty("--transcript-max", step.transcriptMax);
  }

  try {
    // The pre-paint boot below reads this mirror, so persisting is what keeps
    // the next launch from flashing the default width before the store loads.
    window.localStorage.setItem(KEY, step.id);
  } catch {
    // Storage unavailable (or no DOM at all): the step still applies.
  }

  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The applied step's id — lets a caller skip a redundant re-apply. */
export function currentTranscriptWidthId(): TranscriptWidth {
  return current.id;
}

/** Current transcript width step, live across every consumer. */
export function useTranscriptWidth(): TranscriptWidthStep {
  return useSyncExternalStore(subscribe, () => current);
}

// Boot from the persisted mirror so the first frame paints with the chosen
// column cap, well before the store's first backend round-trip resolves.
try {
  applyTranscriptWidth(resolveTranscriptWidth(window.localStorage.getItem(KEY) ?? undefined));
} catch {
  // No storage (or no DOM): the default is already applied.
}
